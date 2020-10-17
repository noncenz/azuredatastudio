/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import 'vs/css!./textCell';
import 'vs/css!./media/markdown';
import 'vs/css!./media/highlight';

import { OnInit, Component, Input, Inject, forwardRef, ElementRef, ChangeDetectorRef, ViewChild, OnChanges, SimpleChange, HostListener, ViewChildren, QueryList } from '@angular/core';

import { localize } from 'vs/nls';
import { IWorkbenchThemeService } from 'vs/workbench/services/themes/common/workbenchThemeService';
import * as themeColors from 'vs/workbench/common/theme';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Emitter } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import * as DOM from 'vs/base/browser/dom';

import { toDisposable } from 'vs/base/common/lifecycle';
import { IMarkdownRenderResult } from 'vs/editor/contrib/markdown/markdownRenderer';
import { NotebookMarkdownRenderer } from 'sql/workbench/contrib/notebook/browser/outputs/notebookMarkdown';
import { CellView } from 'sql/workbench/contrib/notebook/browser/cellViews/interfaces';
import { ICellModel } from 'sql/workbench/services/notebook/browser/models/modelInterfaces';
import { NotebookModel } from 'sql/workbench/services/notebook/browser/models/notebookModel';
import { ISanitizer, defaultSanitizer } from 'sql/workbench/services/notebook/browser/outputs/sanitizer';
import { CodeComponent } from 'sql/workbench/contrib/notebook/browser/cellViews/code.component';
import { NotebookRange, ICellEditorProvider, INotebookService } from 'sql/workbench/services/notebook/browser/notebookService';
import { IColorTheme } from 'vs/platform/theme/common/themeService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import * as turndownPluginGfm from '../turndownPluginGfm';
import TurndownService = require('turndown');
import * as Mark from 'mark.js';
import { NotebookInput } from 'sql/workbench/contrib/notebook/browser/models/notebookInput';
import * as path from 'vs/base/common/path';

export const TEXT_SELECTOR: string = 'text-cell-component';
const USER_SELECT_CLASS = 'actionselect';

@Component({
	selector: TEXT_SELECTOR,
	templateUrl: decodeURI(require.toUrl('./textCell.component.html'))
})
export class TextCellComponent extends CellView implements OnInit, OnChanges {
	@ViewChild('preview', { read: ElementRef }) private output: ElementRef;
	@ViewChildren(CodeComponent) private markdowncodeCell: QueryList<CodeComponent>;

	@Input() cellModel: ICellModel;

	@Input() set model(value: NotebookModel) {
		this._model = value;
	}

	@Input() set activeCellId(value: string) {
		this._activeCellId = value;
	}

	@HostListener('document:keydown.escape', ['$event'])
	handleKeyboardEvent() {
		if (this.isEditMode) {
			this.toggleEditMode(false);
		}
		this.cellModel.active = false;
		this._model.updateActiveCell(undefined);
	}

	// Double click to edit text cell in notebook
	@HostListener('dblclick', ['$event']) onDblClick() {
		this.enableActiveCellEditOnDoubleClick();
	}

	@HostListener('document:keydown', ['$event'])
	onkeydown(e: KeyboardEvent) {
		if (this.isActive()) {
			// select the active .
			if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
				preventDefaultAndExecCommand(e, 'selectAll');
			} else if ((e.metaKey && e.shiftKey && e.key === 'z') || (e.ctrlKey && e.key === 'y')) {
				preventDefaultAndExecCommand(e, 'redo');
			} else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
				preventDefaultAndExecCommand(e, 'undo');
			} else if (e.shiftKey && e.key === 'Tab') {
				preventDefaultAndExecCommand(e, 'outdent');
			} else if (e.key === 'Tab') {
				preventDefaultAndExecCommand(e, 'indent');
			}
		}
	}

	private _content: string | string[];
	private _lastTrustedMode: boolean;
	private isEditMode: boolean;
	private _previewMode: boolean = true;
	private _markdownMode: boolean;
	private _sanitizer: ISanitizer;
	private _model: NotebookModel;
	private _activeCellId: string;
	private readonly _onDidClickLink = this._register(new Emitter<URI>());
	public readonly onDidClickLink = this._onDidClickLink.event;
	private markdownRenderer: NotebookMarkdownRenderer;
	private markdownResult: IMarkdownRenderResult;
	public previewFeaturesEnabled: boolean = false;
	private turndownService;
	public doubleClickEditEnabled: boolean;

	constructor(
		@Inject(forwardRef(() => ChangeDetectorRef)) private _changeRef: ChangeDetectorRef,
		@Inject(IInstantiationService) private _instantiationService: IInstantiationService,
		@Inject(IWorkbenchThemeService) private themeService: IWorkbenchThemeService,
		@Inject(IConfigurationService) private _configurationService: IConfigurationService,
		@Inject(INotebookService) private _notebookService: INotebookService,

	) {
		super();
		this.setTurndownOptions();
		this.markdownRenderer = this._instantiationService.createInstance(NotebookMarkdownRenderer);
		this.doubleClickEditEnabled = this._configurationService.getValue('notebook.enableDoubleClickEdit');
		this._register(toDisposable(() => {
			if (this.markdownResult) {
				this.markdownResult.dispose();
			}
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			this.previewFeaturesEnabled = this._configurationService.getValue('workbench.enablePreviewFeatures');
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			this.doubleClickEditEnabled = this._configurationService.getValue('notebook.enableDoubleClickEdit');
		}));
	}

	public get cellEditors(): ICellEditorProvider[] {
		let editors: ICellEditorProvider[] = [];
		if (this.markdowncodeCell) {
			editors.push(...this.markdowncodeCell.toArray());
		}
		return editors;
	}

	//Gets sanitizer from ISanitizer interface
	private get sanitizer(): ISanitizer {
		if (this._sanitizer) {
			return this._sanitizer;
		}
		return this._sanitizer = defaultSanitizer;
	}

	get model(): NotebookModel {
		return this._model;
	}

	get activeCellId(): string {
		return this._activeCellId;
	}

	private setLoading(isLoading: boolean): void {
		this.cellModel.loaded = !isLoading;
		this._changeRef.detectChanges();
	}

	ngOnInit() {
		this.previewFeaturesEnabled = this._configurationService.getValue('workbench.enablePreviewFeatures');
		this._register(this.themeService.onDidColorThemeChange(this.updateTheme, this));
		this.updateTheme(this.themeService.getColorTheme());
		this.setFocusAndScroll();
		this.cellModel.isEditMode = false;
		this._register(this.cellModel.onOutputsChanged(e => {
			this.updatePreview();
		}));
		this._register(this.cellModel.onCellModeChanged(mode => {
			if (mode !== this.isEditMode) {
				this.toggleEditMode(mode);
			}
			this._changeRef.detectChanges();
		}));
		this._register(this.cellModel.onCellPreviewModeChanged(preview => {
			this.previewMode = preview;
			this.focusIfPreviewMode();
		}));
		this._register(this.cellModel.onCellMarkdownModeChanged(markdown => {
			this.markdownMode = markdown;
			this.focusIfPreviewMode();
		}));
	}

	ngOnChanges(changes: { [propKey: string]: SimpleChange }) {
		for (let propName in changes) {
			if (propName === 'activeCellId') {
				let changedProp = changes[propName];
				this._activeCellId = changedProp.currentValue;
				this.toggleUserSelect(this.isActive());
				// If the activeCellId is undefined (i.e. in an active cell update), don't unnecessarily set editMode to false;
				// it will be set to true in a subsequent call to toggleEditMode()
				if (changedProp.previousValue !== undefined) {
					this.toggleEditMode(false);
				}
				break;
			}
		}
	}

	public cellGuid(): string {
		return this.cellModel.cellGuid;
	}

	public get isTrusted(): boolean {
		return this.model.trustedMode;
	}

	public get notebookUri(): URI {
		return this.model.notebookUri;
	}

	/**
	 * Updates the preview of markdown component with latest changes
	 * If content is empty and in non-edit mode, default it to 'Add content here...' or 'Double-click to edit' depending on setting
	 * Sanitizes the data to be shown in markdown cell
	 */
	private updatePreview(): void {
		let trustedChanged = this.cellModel && this._lastTrustedMode !== this.cellModel.trustedMode;
		let cellModelSourceJoined = Array.isArray(this.cellModel.source) ? this.cellModel.source.join('') : this.cellModel.source;
		let contentJoined = Array.isArray(this._content) ? this._content.join('') : this._content;
		let contentChanged = contentJoined !== cellModelSourceJoined || cellModelSourceJoined.length === 0 || this._previewMode === true;
		if (trustedChanged || contentChanged) {
			this._lastTrustedMode = this.cellModel.trustedMode;
			if ((!cellModelSourceJoined) && !this.isEditMode) {
				if (this.doubleClickEditEnabled) {
					this._content = localize('doubleClickEdit', "<i>Double-click to edit</i>");
				} else {
					this._content = localize('addContent', "<i>Add content here...</i>");
				}
			} else {
				this._content = this.cellModel.source[0] === '' ? '<p>&nbsp;</p>' : this.cellModel.source;
			}
			this.markdownRenderer.setNotebookURI(this.cellModel.notebookModel.notebookUri);
			this.markdownResult = this.markdownRenderer.render({
				isTrusted: true,
				value: Array.isArray(this._content) ? this._content.join('') : this._content
			});
			this.markdownResult.element.innerHTML = this.sanitizeContent(this.markdownResult.element.innerHTML);
			this.setLoading(false);
			if (this._previewMode) {
				let outputElement = <HTMLElement>this.output.nativeElement;
				outputElement.innerHTML = this.markdownResult.element.innerHTML;
				this.cellModel.renderedOutputTextContent = this.getRenderedTextOutput();
				outputElement.focus();
			}
		}
	}

	private updateCellSource(): void {
		let textOutputElement = <HTMLElement>this.output.nativeElement;
		let newCellSource: string = this.turndownService.turndown(textOutputElement.innerHTML, { gfm: true });
		this.cellModel.source = newCellSource;
		this._changeRef.detectChanges();
	}

	//Sanitizes the content based on trusted mode of Cell Model
	private sanitizeContent(content: string): string {
		if (this.cellModel && !this.cellModel.trustedMode) {
			content = this.sanitizer.sanitize(content);
		}
		return content;
	}

	// Todo: implement layout
	public layout() {
	}

	private updateTheme(theme: IColorTheme): void {
		let outputElement = <HTMLElement>this.output?.nativeElement;
		if (outputElement) {
			outputElement.style.borderTopColor = theme.getColor(themeColors.SIDE_BAR_BACKGROUND, true).toString();
		}
	}

	public handleContentChanged(): void {
		this.updatePreview();
	}

	public handleHtmlChanged(): void {
		this.updateCellSource();
	}

	public toggleEditMode(editMode?: boolean): void {
		this.isEditMode = editMode !== undefined ? editMode : !this.isEditMode;
		this.cellModel.isEditMode = this.isEditMode;
		if (!this.isEditMode) {
			this.cellModel.showPreview = true;
			this.cellModel.showMarkdown = false;
		} else {
			this.markdownMode = this.cellModel.showMarkdown;
		}
		this.updatePreview();
		this._changeRef.detectChanges();
	}

	public get previewMode(): boolean {
		return this._previewMode;
	}
	public set previewMode(value: boolean) {
		if (this._previewMode !== value) {
			this._previewMode = value;
			this.updatePreview();
			this._changeRef.detectChanges();
		}
	}

	public get markdownMode(): boolean {
		return this._markdownMode;
	}
	public set markdownMode(value: boolean) {
		if (this._markdownMode !== value) {
			this._markdownMode = value;
			this._changeRef.detectChanges();
		}
	}

	private toggleUserSelect(userSelect: boolean): void {
		if (!this.output) {
			return;
		}
		if (userSelect) {
			DOM.addClass(this.output.nativeElement, USER_SELECT_CLASS);
		} else {
			DOM.removeClass(this.output.nativeElement, USER_SELECT_CLASS);
		}
	}

	private setFocusAndScroll(): void {
		this.toggleEditMode(this.isActive());

		if (this.output && this.output.nativeElement) {
			let outputElement = this.output.nativeElement as HTMLElement;
			outputElement.scrollTo({ behavior: 'smooth' });
		}
	}

	private focusIfPreviewMode(): void {
		if (this.previewMode && !this.markdownMode) {
			let outputElement = this.output?.nativeElement as HTMLElement;
			if (outputElement) {
				outputElement.focus();
			}
		}
	}

	protected isActive(): boolean {
		return this.cellModel && this.cellModel.id === this.activeCellId;
	}

	public deltaDecorations(newDecorationRange: NotebookRange, oldDecorationRange: NotebookRange): void {
		if (oldDecorationRange) {
			this.removeDecoration(oldDecorationRange);
		}

		if (newDecorationRange) {
			this.addDecoration(newDecorationRange);
		}
	}

	private addDecoration(range: NotebookRange): void {
		if (range && this.output && this.output.nativeElement) {
			let elements = this.getHtmlElements();
			if (elements?.length >= range.startLineNumber) {
				let elementContainingText = elements[range.startLineNumber - 1];
				let mark = new Mark(elementContainingText);
				let editor = this._notebookService.findNotebookEditor(this.model.notebookUri);
				if (editor) {
					let findModel = (editor.notebookParams.input as NotebookInput).notebookFindModel;
					if (findModel?.findMatches?.length > 0) {
						let searchString = findModel.findExpression;
						mark.mark(searchString, {
							className: 'rangeHighlight'
						});
						elementContainingText.scrollIntoView({ behavior: 'smooth' });
					}
				}
			}
		}
	}

	private removeDecoration(range: NotebookRange): void {
		if (range && this.output && this.output.nativeElement) {
			let elements = this.getHtmlElements();
			let elementContainingText = elements[range.startLineNumber - 1];
			let mark = new Mark(elementContainingText);
			mark.unmark({ acrossElements: true, className: 'rangeHighlight' });
		}
	}

	private getHtmlElements(): any[] {
		let hostElem = this.output?.nativeElement;
		let children = [];
		if (hostElem) {
			for (let element of hostElem.children) {
				if (element.nodeName.toLowerCase() === 'table') {
					// add table header and table rows.
					if (element.children.length > 0) {
						children.push(element.children[0]);
						if (element.children.length > 1) {
							for (let trow of element.children[1].children) {
								children.push(trow);
							}
						}
					}
				} else if (element.children.length > 1) {
					children = children.concat(this.getChildren(element));
				} else {
					children.push(element);
				}
			}
		}
		return children;
	}

	private getChildren(parent: any): any[] {
		let children: any = [];
		if (parent.children.length > 1 && parent.nodeName.toLowerCase() !== 'li' && parent.nodeName.toLowerCase() !== 'p') {
			for (let child of parent.children) {
				children = children.concat(this.getChildren(child));
			}
		} else {
			return parent;
		}
		return children;
	}

	private getRenderedTextOutput(): string[] {
		let textOutput: string[] = [];
		let elements = this.getHtmlElements();
		elements.forEach(element => {
			if (element && element.innerText) {
				textOutput.push(element.innerText);
			} else {
				textOutput.push('');
			}
		});
		return textOutput;
	}

	private setTurndownOptions() {
		this.turndownService = new TurndownService({ 'emDelimiter': '_', 'bulletListMarker': '-', 'headingStyle': 'atx' });
		this.turndownService.keep(['u', 'mark']);
		this.turndownService.use(turndownPluginGfm.gfm);
		this.turndownService.addRule('pre', {
			filter: 'pre',
			replacement: function (content, node) {
				return '\n```\n' + node.textContent + '\n```\n';
			}
		});
		this.turndownService.addRule('caption', {
			filter: 'caption',
			replacement: function (content, node) {
				return `${node.outerHTML}
				`;
			}
		});
		this.turndownService.addRule('span', {
			filter: function (node, options) {
				return (
					node.nodeName === 'MARK' ||
					(node.nodeName === 'SPAN' &&
						node.getAttribute('style') === 'background-color: yellow;')
				);
			},
			replacement: function (content, node) {
				if (node.nodeName === 'SPAN') {
					return '<mark>' + node.textContent + '</mark>';
				}
				return node.textContent;
			}
		});
		this.turndownService.addRule('img', {
			filter: 'img',
			replacement: (content, node) => {
				if (node?.src) {
					let imgPath = URI.parse(node.src);
					const notebookFolder: string = this.notebookUri ? path.join(path.dirname(this.notebookUri.fsPath), path.sep) : '';
					let relativePath = findPathRelativeToContent(notebookFolder, imgPath);
					if (relativePath) {
						return `![${node.alt}](${relativePath})`;
					}
				}
				return `![${node.alt}](${node.src})`;
			}
		});
		this.turndownService.addRule('a', {
			filter: 'a',
			replacement: (content, node) => {
				//On Windows, if notebook is not trusted then the href attr is removed for all non-web URL links
				// href contains either a hyperlink or a URI-encoded absolute path. (See resolveUrls method in notebookMarkdown.ts)
				const notebookLink = node.href ? URI.parse(node.href) : URI.file(node.title);
				const notebookFolder = this.notebookUri ? path.join(path.dirname(this.notebookUri.fsPath), path.sep) : '';
				let relativePath = findPathRelativeToContent(notebookFolder, notebookLink);
				if (relativePath) {
					return `[${node.innerText}](${relativePath})`;
				}
				return `[${node.innerText}](${node.href})`;
			}
		});
	}

	// Enables edit mode on double clicking active cell
	private enableActiveCellEditOnDoubleClick() {
		if (!this.isEditMode && this.doubleClickEditEnabled) {
			this.toggleEditMode(true);
		}
		this.cellModel.active = true;
		this._model.updateActiveCell(this.cellModel);
	}
}

export function findPathRelativeToContent(notebookFolder: string, contentPath: URI | undefined): string {
	if (notebookFolder) {
		if (contentPath?.scheme === 'file') {
			let relativePath = path.relative(notebookFolder, contentPath.fsPath);
			//if path contains whitespaces then it's not identified as a link
			relativePath = relativePath.replace(/\s/g, '%20');
			if (relativePath.startsWith(path.join('..', path.sep) || path.join('.', path.sep))) {
				return relativePath;
			} else {
				// if the relative path does not contain ./ at the beginning, we need to add it so it's recognized as a link
				return `.${path.join(path.sep, relativePath)}`;
			}
		}
	}
	return '';
}

function preventDefaultAndExecCommand(e: KeyboardEvent, commandId: string) {
	// use preventDefault() to avoid invoking the editor's select all
	e.preventDefault();
	document.execCommand(commandId);
}
