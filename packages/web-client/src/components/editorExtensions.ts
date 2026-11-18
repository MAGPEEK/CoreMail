import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/react';
import ImageExt from '@tiptap/extension-image';
import { SIGNATURE_BLOCK_ATTR, signatureBlockHtml } from '../lib/signaturePick.js';

/**
 * Custom font-size extension (TipTap has no standard extension for this):
 * the inline `style="font-size: …"` attribute on the textStyle mark.
 * We define NO global module augmentation for Commands<> (avoids ChainedCommands
 * conflicts); callers set the mark directly via setMark/unsetMark.
 * Shared by the signature editor and the compose editor, so signatures with
 * font sizes survive being inserted into a new mail.
 */
export const FontSizeExt = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] as string[] };
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.fontSize || null,
          renderHTML: (attrs: Record<string, unknown>) => attrs['fontSize']
            ? { style: `font-size: ${attrs['fontSize']}` }
            : {},
        },
      },
    }];
  },
});

/** Inline images (signature logos, quoted images) incl. data: URIs. */
export const InlineImageExt = ImageExt.configure({
  inline: true,
  allowBase64: true,
  HTMLAttributes: { class: 'inline-block max-w-full h-auto' },
});

/**
 * 9.4: the signature inside a compose body — a block wrapper
 * (`<div data-cm-signature>`), so a sender change or the signature picker can
 * replace exactly the signature and nothing the user wrote.
 */
export const SignatureBlockExt = Node.create({
  name: 'signatureBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML() {
    return [{ tag: `div[${SIGNATURE_BLOCK_ATTR}]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { [SIGNATURE_BLOCK_ATTR]: '' }), 0];
  },
});

type Doc = Editor['state']['doc'];

/** The own signature: a top-level block (a quoted original's signature sits inside its blockquote). */
function findSignatureBlock(doc: Doc): { pos: number; size: number; json: string } | null {
  let offset = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === 'signatureBlock') return { pos: offset, size: child.nodeSize, json: JSON.stringify(child.toJSON()) };
    offset += child.nodeSize;
  }
  return null;
}

/** Content of the signature block as JSON (compare with what was inserted), null = none. */
export function signatureBlockState(editor: Editor): string | null {
  return findSignatureBlock(editor.state.doc)?.json ?? null;
}

/** Where a new signature goes: before the quoted original, else at the end. */
function signatureInsertPos(doc: Doc): number {
  let pos = doc.content.size;
  let offset = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === 'blockquote') { pos = offset; break; }
    offset += child.nodeSize;
  }
  return pos;
}

/** Replaces (or inserts / removes, html '') the signature of the compose body. */
export function replaceSignatureBlock(editor: Editor, html: string): void {
  const block = findSignatureBlock(editor.state.doc);
  const content = signatureBlockHtml(html);
  if (block) {
    const range = { from: block.pos, to: block.pos + block.size };
    if (content) editor.chain().insertContentAt(range, content).run();
    else editor.chain().deleteRange(range).run();
  } else if (content) {
    editor.chain().insertContentAt(signatureInsertPos(editor.state.doc), content).run();
  }
}
