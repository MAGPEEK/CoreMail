import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { Bold, Italic, Underline as UnderlineIcon, List, ListOrdered } from 'lucide-react';

/**
 * 9.4: rich-text note of the task form (bold, italic, underline, lists). Reports
 * HTML and the plain text (the server keeps both: body = text for search and
 * clients without HTML, bodyHtml for the webmail).
 */
interface Props {
  html: string;
  onChange: (html: string, text: string) => void;
  label: string;
}

export function RichNoteEditor({ html, onChange, label }: Props) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, codeBlock: false }), Underline],
    content: html,
    editorProps: { attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', class: 'min-h-[6rem] px-2 py-1.5 text-sm text-fg focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5' } },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? '' : e.getHTML(), e.getText()),
  });
  // a different task opened in the same form
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getHTML() !== html) editor.commands.setContent(html || '', false);
  }, [editor, html]);

  const btn = (active: boolean, title: string, onClick: () => void, icon: React.ReactNode) => (
    <button type="button" title={title} aria-label={title} aria-pressed={active} onClick={onClick}
      className={`p-1 rounded ${active ? 'bg-surface-3 text-fg' : 'text-fg-subtle hover:bg-surface-2'}`}>
      {icon}
    </button>
  );

  return (
    <div className="border border-line-strong rounded bg-surface focus-within:ring-1 focus-within:ring-accent-fg">
      <div role="toolbar" aria-label={`${label}: Format`} className="flex gap-0.5 px-1 py-0.5 border-b border-line">
        {btn(!!editor?.isActive('bold'), 'Fett', () => editor?.chain().focus().toggleBold().run(), <Bold size={13} />)}
        {btn(!!editor?.isActive('italic'), 'Kursiv', () => editor?.chain().focus().toggleItalic().run(), <Italic size={13} />)}
        {btn(!!editor?.isActive('underline'), 'Unterstrichen', () => editor?.chain().focus().toggleUnderline().run(), <UnderlineIcon size={13} />)}
        {btn(!!editor?.isActive('bulletList'), 'Aufzählung', () => editor?.chain().focus().toggleBulletList().run(), <List size={13} />)}
        {btn(!!editor?.isActive('orderedList'), 'Nummerierung', () => editor?.chain().focus().toggleOrderedList().run(), <ListOrdered size={13} />)}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
