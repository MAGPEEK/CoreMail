/**
 * 9.4: the Tiptap editor of the compose area. Same extensions as before
 * (formatting, colours, fonts, sizes, links, inline images incl. data: URIs,
 * the signature block) plus the quote marker and tables (also those of a
 * quoted original, which were flattened before). Pasting an image file inserts
 * it (raster images only, lib/composeRules.ts inlineImageProblem). 9.4 refine:
 * superscript / subscript and the text direction of a block; the placeholder
 * of the empty body is announced through aria-placeholder.
 */
import { useRef } from 'react';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import UnderlineExt from '@tiptap/extension-underline';
import LinkExt from '@tiptap/extension-link';
import TextAlignExt from '@tiptap/extension-text-align';
import { Color } from '@tiptap/extension-color';
import TextStyle from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import FontFamilyExt from '@tiptap/extension-font-family';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { TABLE_CELL_STYLE, TABLE_STYLE } from '../lib/composeFormat.js';
import {
  FontSizeExt, InlineImageExt, QuoteMarkerExt, SignatureBlockExt, SubscriptExt, SuperscriptExt, TextDirectionExt,
} from '../components/editorExtensions.js';

/** Editor area classes: headings, quotes (the quoted original without italics), lists, code, links. */
export const COMPOSE_EDITOR_CLASS = [
  'px-4 py-3',
  '[&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h1]:mb-2 [&_.ProseMirror_h1]:mt-3',
  '[&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-2',
  '[&_.ProseMirror_h3]:text-base [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h3]:mb-1 [&_.ProseMirror_h3]:mt-2',
  '[&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-line-strong [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:text-fg-subtle [&_.ProseMirror_blockquote]:italic [&_.ProseMirror_blockquote]:my-2',
  '[&_.ProseMirror_blockquote[data-cm-quote]]:border-l-0 [&_.ProseMirror_blockquote[data-cm-quote]]:pl-0 [&_.ProseMirror_blockquote[data-cm-quote]]:not-italic [&_.ProseMirror_blockquote[data-cm-quote]]:text-fg-muted',
  '[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_ul]:my-1',
  '[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_ol]:my-1',
  '[&_.ProseMirror_li]:my-0.5',
  '[&_.ProseMirror_:not(pre)>code]:bg-surface-2 [&_.ProseMirror_:not(pre)>code]:text-danger-fg [&_.ProseMirror_:not(pre)>code]:font-mono [&_.ProseMirror_:not(pre)>code]:text-xs [&_.ProseMirror_:not(pre)>code]:px-1.5 [&_.ProseMirror_:not(pre)>code]:py-0.5 [&_.ProseMirror_:not(pre)>code]:rounded',
  '[&_.ProseMirror_pre]:bg-surface-2 [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:font-mono [&_.ProseMirror_pre]:text-xs [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:my-2',
  '[&_.ProseMirror_a]:text-accent-fg [&_.ProseMirror_a]:underline [&_.ProseMirror_a]:cursor-pointer',
  '[&_.ProseMirror_hr]:border-line [&_.ProseMirror_hr]:my-4',
  '[&_.ProseMirror_.selectedCell]:bg-accent/10',
  '[&_.ProseMirror_p]:mb-1',
].join(' ');

/** Folds the quoted original (still part of the mail). */
export const QUOTE_FOLDED_CLASS = '[&_.ProseMirror_blockquote[data-cm-quote]]:hidden';

export function useComposeEditor(o: { label: string; placeholder: string; onPasteImage: (file: File) => void }) {
  const paste = useRef(o.onPasteImage);
  paste.current = o.onPasteImage;
  return useEditor({
    extensions: [
      StarterKit,
      UnderlineExt,
      LinkExt.configure({ openOnClick: false }),
      TextAlignExt.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      FontFamilyExt,
      // Same as the signature editor: font sizes + images of signatures and quoted originals must survive
      FontSizeExt,
      InlineImageExt,
      SignatureBlockExt,
      QuoteMarkerExt,
      Table.configure({ resizable: false, HTMLAttributes: { style: TABLE_STYLE } }),
      TableRow,
      TableHeader.configure({ HTMLAttributes: { style: TABLE_CELL_STYLE } }),
      TableCell.configure({ HTMLAttributes: { style: TABLE_CELL_STYLE } }),
      SuperscriptExt,
      SubscriptExt,
      TextDirectionExt,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'outline-none min-h-[160px] text-sm leading-relaxed',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': o.label,
        'aria-placeholder': o.placeholder,
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        for (const f of files) paste.current(f);
        return true;
      },
    },
  });
}
