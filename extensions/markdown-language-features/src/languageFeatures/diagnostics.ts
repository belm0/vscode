/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { MarkdownEngine } from '../markdownEngine';
import { TableOfContents } from '../tableOfContents';
import { Delayer } from '../util/async';
import { Disposable } from '../util/dispose';
import { isMarkdownFile } from '../util/file';
import { Limiter } from '../util/limiter';
import { MdWorkspaceContents, SkinnyTextDocument } from '../workspaceContents';
import { InternalHref, LinkDefinitionSet, MdLink, MdLinkProvider, MdLinkSource } from './documentLinkProvider';
import { tryFindMdDocumentForLink } from './references';

const localize = nls.loadMessageBundle();

export interface DiagnosticConfiguration {
	/**
	 * Fired when the configuration changes.
	 */
	readonly onDidChange: vscode.Event<void>;

	getOptions(resource: vscode.Uri): DiagnosticOptions;
}

export enum DiagnosticLevel {
	ignore = 'ignore',
	warning = 'warning',
	error = 'error',
}

export interface DiagnosticOptions {
	readonly enabled: boolean;
	readonly validateReferences: DiagnosticLevel;
	readonly validateOwnHeaders: DiagnosticLevel;
	readonly validateFilePaths: DiagnosticLevel;
}

function toSeverity(level: DiagnosticLevel): vscode.DiagnosticSeverity | undefined {
	switch (level) {
		case DiagnosticLevel.error: return vscode.DiagnosticSeverity.Error;
		case DiagnosticLevel.warning: return vscode.DiagnosticSeverity.Warning;
		case DiagnosticLevel.ignore: return undefined;
	}
}

class VSCodeDiagnosticConfiguration extends Disposable implements DiagnosticConfiguration {

	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	public readonly onDidChange = this._onDidChange.event;

	constructor() {
		super();

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('markdown.experimental.validate.enabled')) {
				this._onDidChange.fire();
			}
		}));
	}

	public getOptions(resource: vscode.Uri): DiagnosticOptions {
		const config = vscode.workspace.getConfiguration('markdown', resource);
		return {
			enabled: config.get<boolean>('experimental.validate.enabled', false),
			validateReferences: config.get<DiagnosticLevel>('experimental.validate.referenceLinks', DiagnosticLevel.ignore),
			validateOwnHeaders: config.get<DiagnosticLevel>('experimental.validate.headerLinks', DiagnosticLevel.ignore),
			validateFilePaths: config.get<DiagnosticLevel>('experimental.validate.fileLinks', DiagnosticLevel.ignore),
		};
	}
}

class InflightDiagnosticRequests {

	private readonly inFlightRequests = new Map<string, { readonly cts: vscode.CancellationTokenSource }>();

	public trigger(resource: vscode.Uri, compute: (token: vscode.CancellationToken) => Promise<void>) {
		this.cancel(resource);

		const key = this.getResourceKey(resource);
		const cts = new vscode.CancellationTokenSource();
		const entry = { cts };
		this.inFlightRequests.set(key, entry);

		compute(cts.token).finally(() => {
			if (this.inFlightRequests.get(key) === entry) {
				this.inFlightRequests.delete(key);
			}
			cts.dispose();
		});
	}

	public cancel(resource: vscode.Uri) {
		const key = this.getResourceKey(resource);
		const existing = this.inFlightRequests.get(key);
		if (existing) {
			existing.cts.cancel();
			this.inFlightRequests.delete(key);
		}
	}

	public dispose() {
		this.clear();
	}

	public clear() {
		for (const { cts } of this.inFlightRequests.values()) {
			cts.dispose();
		}
		this.inFlightRequests.clear();
	}

	private getResourceKey(resource: vscode.Uri): string {
		return resource.toString();
	}
}

class LinkWatcher extends Disposable {

	private readonly _onDidChangeLinkedToFile = this._register(new vscode.EventEmitter<Iterable<vscode.Uri>>);
	/**
	 * Event fired with a list of document uri when one of the links in the document changes
	 */
	public readonly onDidChangeLinkedToFile = this._onDidChangeLinkedToFile.event;

	private readonly _watchers = new Map</* link path */ string, {
		/**
		 * Watcher for this link path
		 */
		readonly watcher: vscode.Disposable;

		/**
		 * List of documents that reference the link
		 */
		readonly documents: Map</* document resource as string */ string, /* document resource*/ vscode.Uri>;
	}>();

	override dispose() {
		super.dispose();

		for (const entry of this._watchers.values()) {
			entry.watcher.dispose();
		}
		this._watchers.clear();
	}

	/**
	 * Set the known links in a markdown document, adding and removing file watchers as needed
	 */
	updateLinksForDocument(document: vscode.Uri, links: readonly MdLink[]) {
		const linkedToResource = new Set<vscode.Uri>(
			links
				.filter(link => link.href.kind === 'internal')
				.map(link => (link.href as InternalHref).path));

		// First decrement watcher counter for previous document state
		for (const entry of this._watchers.values()) {
			entry.documents.delete(document.toString());
		}

		// Then create/update watchers for new document state
		for (const path of linkedToResource) {
			let entry = this._watchers.get(path.toString());
			if (!entry) {
				entry = {
					watcher: this.startWatching(path),
					documents: new Map(),
				};
				this._watchers.set(path.toString(), entry);
			}

			entry.documents.set(document.toString(), document);
		}

		// Finally clean up watchers for links that are no longer are referenced anywhere
		for (const [key, value] of this._watchers) {
			if (value.documents.size === 0) {
				value.watcher.dispose();
				this._watchers.delete(key);
			}
		}
	}

	deleteDocument(resource: vscode.Uri) {
		this.updateLinksForDocument(resource, []);
	}

	private startWatching(path: vscode.Uri): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path, '*'), false, true, false);
		const handler = (resource: vscode.Uri) => this.onLinkedResourceChanged(resource);
		return vscode.Disposable.from(
			watcher,
			watcher.onDidDelete(handler),
			watcher.onDidCreate(handler),
		);
	}

	private onLinkedResourceChanged(resource: vscode.Uri) {
		const entry = this._watchers.get(resource.toString());
		if (entry) {
			this._onDidChangeLinkedToFile.fire(entry.documents.values());
		}
	}
}

export class DiagnosticManager extends Disposable {

	private readonly collection: vscode.DiagnosticCollection;

	private readonly diagnosticDelayer: Delayer<void>;
	private readonly pendingDiagnostics = new Set<vscode.Uri>();
	private readonly inFlightDiagnostics = this._register(new InflightDiagnosticRequests());

	private readonly linkWatcher = this._register(new LinkWatcher());

	constructor(
		private readonly computer: DiagnosticComputer,
		private readonly configuration: DiagnosticConfiguration,
	) {
		super();

		this.diagnosticDelayer = this._register(new Delayer(300));

		this.collection = this._register(vscode.languages.createDiagnosticCollection('markdown'));

		this._register(this.configuration.onDidChange(() => {
			this.rebuild();
		}));

		this._register(vscode.workspace.onDidOpenTextDocument(doc => {
			this.triggerDiagnostics(doc);
		}));

		this._register(vscode.workspace.onDidChangeTextDocument(e => {
			this.triggerDiagnostics(e.document);
		}));

		this._register(vscode.workspace.onDidCloseTextDocument(({ uri }) => {
			this.pendingDiagnostics.delete(uri);
			this.inFlightDiagnostics.cancel(uri);
			this.linkWatcher.deleteDocument(uri);
			this.collection.delete(uri);
		}));

		this._register(this.linkWatcher.onDidChangeLinkedToFile(changedDocuments => {
			for (const resource of changedDocuments) {
				const doc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === resource.toString());
				if (doc) {
					this.triggerDiagnostics(doc);
				}
			}
		}));

		this.rebuild();
	}

	public override dispose() {
		super.dispose();
		this.pendingDiagnostics.clear();
	}

	public async recomputeDiagnosticState(doc: SkinnyTextDocument, token: vscode.CancellationToken): Promise<{ diagnostics: readonly vscode.Diagnostic[]; links: readonly MdLink[]; config: DiagnosticOptions }> {
		const config = this.configuration.getOptions(doc.uri);
		if (!config.enabled) {
			return { diagnostics: [], links: [], config };
		}
		return { ...await this.computer.getDiagnostics(doc, config, token), config };
	}

	private async recomputePendingDiagnostics(): Promise<void> {
		const pending = [...this.pendingDiagnostics];
		this.pendingDiagnostics.clear();

		for (const resource of pending) {
			const doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === resource.fsPath);
			if (doc) {
				this.inFlightDiagnostics.trigger(doc.uri, async (token) => {
					const state = await this.recomputeDiagnosticState(doc, token);
					this.linkWatcher.updateLinksForDocument(doc.uri, state.config.enabled && state.config.validateFilePaths ? state.links : []);
					this.collection.set(doc.uri, state.diagnostics);
				});
			}
		}
	}

	private async rebuild() {
		this.collection.clear();
		this.pendingDiagnostics.clear();
		this.inFlightDiagnostics.clear();

		const allOpenedTabResources = this.getAllTabResources();
		await Promise.all(
			vscode.workspace.textDocuments
				.filter(doc => allOpenedTabResources.has(doc.uri.toString()) && isMarkdownFile(doc))
				.map(doc => this.triggerDiagnostics(doc)));
	}

	private getAllTabResources() {
		const openedTabDocs = new Map<string, vscode.Uri>();
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText) {
					openedTabDocs.set(tab.input.uri.toString(), tab.input.uri);
				}
			}
		}
		return openedTabDocs;
	}

	private triggerDiagnostics(doc: vscode.TextDocument) {
		this.inFlightDiagnostics.cancel(doc.uri);

		if (isMarkdownFile(doc)) {
			this.pendingDiagnostics.add(doc.uri);
			this.diagnosticDelayer.trigger(() => this.recomputePendingDiagnostics());
		}
	}
}

interface FileLinksData {
	readonly path: vscode.Uri;

	readonly links: Array<{
		readonly source: MdLinkSource;
		readonly fragment: string;
	}>;
}

/**
 * Map of file paths to markdown links to that file.
 */
class FileLinkMap {

	private readonly _filesToLinksMap = new Map<string, FileLinksData>();

	constructor(links: Iterable<MdLink>) {
		for (const link of links) {
			if (link.href.kind !== 'internal') {
				continue;
			}

			const fileKey = link.href.path.toString();
			const existingFileEntry = this._filesToLinksMap.get(fileKey);
			const linkData = { source: link.source, fragment: link.href.fragment };
			if (existingFileEntry) {
				existingFileEntry.links.push(linkData);
			} else {
				this._filesToLinksMap.set(fileKey, { path: link.href.path, links: [linkData] });
			}
		}
	}

	public get size(): number {
		return this._filesToLinksMap.size;
	}

	public entries(): Iterable<FileLinksData> {
		return this._filesToLinksMap.values();
	}
}

export class DiagnosticComputer {

	constructor(
		private readonly engine: MarkdownEngine,
		private readonly workspaceContents: MdWorkspaceContents,
		private readonly linkProvider: MdLinkProvider,
	) { }

	public async getDiagnostics(doc: SkinnyTextDocument, options: DiagnosticOptions, token: vscode.CancellationToken): Promise<{ readonly diagnostics: vscode.Diagnostic[]; readonly links: MdLink[] }> {
		const links = await this.linkProvider.getAllLinks(doc, token);
		if (token.isCancellationRequested) {
			return { links, diagnostics: [] };
		}

		return {
			links,
			diagnostics: (await Promise.all([
				this.validateFileLinks(doc, options, links, token),
				Array.from(this.validateReferenceLinks(options, links)),
				this.validateOwnHeaderLinks(doc, options, links, token),
			])).flat()
		};
	}

	private async validateOwnHeaderLinks(doc: SkinnyTextDocument, options: DiagnosticOptions, links: readonly MdLink[], token: vscode.CancellationToken): Promise<vscode.Diagnostic[]> {
		const severity = toSeverity(options.validateOwnHeaders);
		if (typeof severity === 'undefined') {
			return [];
		}

		const toc = await TableOfContents.create(this.engine, doc);
		if (token.isCancellationRequested) {
			return [];
		}

		const diagnostics: vscode.Diagnostic[] = [];
		for (const link of links) {
			if (link.href.kind === 'internal'
				&& link.href.path.toString() === doc.uri.toString()
				&& link.href.fragment
				&& !toc.lookup(link.href.fragment)
			) {
				diagnostics.push(new vscode.Diagnostic(
					link.source.hrefRange,
					localize('invalidHeaderLink', 'No header found: \'{0}\'', link.href.fragment),
					severity));
			}
		}

		return diagnostics;
	}

	private *validateReferenceLinks(options: DiagnosticOptions, links: readonly MdLink[]): Iterable<vscode.Diagnostic> {
		const severity = toSeverity(options.validateReferences);
		if (typeof severity === 'undefined') {
			return [];
		}

		const definitionSet = new LinkDefinitionSet(links);
		for (const link of links) {
			if (link.href.kind === 'reference' && !definitionSet.lookup(link.href.ref)) {
				yield new vscode.Diagnostic(
					link.source.hrefRange,
					localize('invalidReferenceLink', 'No link reference found: \'{0}\'', link.href.ref),
					severity);
			}
		}
	}

	private async validateFileLinks(doc: SkinnyTextDocument, options: DiagnosticOptions, links: readonly MdLink[], token: vscode.CancellationToken): Promise<vscode.Diagnostic[]> {
		const severity = toSeverity(options.validateFilePaths);
		if (typeof severity === 'undefined') {
			return [];
		}

		const linkSet = new FileLinkMap(links);
		if (linkSet.size === 0) {
			return [];
		}

		const limiter = new Limiter(10);

		const diagnostics: vscode.Diagnostic[] = [];
		await Promise.all(
			Array.from(linkSet.entries()).map(({ path, links }) => {
				return limiter.queue(async () => {
					if (token.isCancellationRequested) {
						return;
					}

					const hrefDoc = await tryFindMdDocumentForLink({ kind: 'internal', path: path, fragment: '' }, this.workspaceContents);
					if (hrefDoc && hrefDoc.uri.toString() === doc.uri.toString()) {
						// We've already validated our own links in `validateOwnHeaderLinks`
						return;
					}

					if (!hrefDoc && !await this.workspaceContents.pathExists(path)) {
						const msg = localize('invalidPathLink', 'File does not exist at path: {0}', path.toString(true));
						for (const link of links) {
							diagnostics.push(new vscode.Diagnostic(link.source.hrefRange, msg, severity));
						}
					} else if (hrefDoc) {
						// Validate each of the links to headers in the file
						const fragmentLinks = links.filter(x => x.fragment);
						if (fragmentLinks.length) {
							const toc = await TableOfContents.create(this.engine, hrefDoc);
							for (const link of fragmentLinks) {
								if (!toc.lookup(link.fragment)) {
									const msg = localize('invalidLinkToHeaderInOtherFile', 'Header does not exist in file: {0}', link.fragment);
									diagnostics.push(new vscode.Diagnostic(link.source.hrefRange, msg, severity));
								}
							}
						}
					}
				});
			}));
		return diagnostics;
	}
}

export function register(
	engine: MarkdownEngine,
	workspaceContents: MdWorkspaceContents,
	linkProvider: MdLinkProvider,
): vscode.Disposable {
	const configuration = new VSCodeDiagnosticConfiguration();
	const manager = new DiagnosticManager(new DiagnosticComputer(engine, workspaceContents, linkProvider), configuration);
	return vscode.Disposable.from(configuration, manager);
}
