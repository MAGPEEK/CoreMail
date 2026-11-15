import { Extension } from '@tiptap/react';
import ImageExt from '@tiptap/extension-image';

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
