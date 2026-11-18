/**
 * 9.4: the compose area — inline in the reading pane (new mail, reply, reply
 * all, forward, a reopened draft) or in its own window (/compose/<draftId>).
 * Command row, fields, status line + attachments, body, formatting toolbar,
 * action bar; files dropped anywhere on it are attached. Server draft
 * semantics are those of 8.1/9.3 (autosave, undo hold, schedule, discard); the
 * inventory and the model are in docs/compose.md. Esc saves and closes,
 * Ctrl/⌘+Enter sends.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent } from '@tiptap/react';
import { Loader2, Paperclip } from 'lucide-react';
import toast from 'react-hot-toast';
import { ComposeCommandRow, type ComposeCommandActions, type ComposeCommandState } from './ComposeCommandRow.js';
import { ComposeFormatBar } from './ComposeFormatBar.js';
import { ComposeActionBar } from './ComposeActionBar.js';
import { MessageOptionsDialog, type MessageOptions } from './MessageOptionsDialog.js';
import { AccessibilityDialog } from './AccessibilityDialog.js';
import { ComposeFields } from './ComposeFields.js';
import { AttachmentChips } from './AttachmentChips.js';
import { SchedulePopover } from './SchedulePopover.js';
import { EmojiPopover } from './EmojiPopover.js';
import { PromptDialog } from '../PromptDialog.js';
import { isModalOpen } from '../Modal.js';
import { queueHeldSend } from '../DelayedSendToast.js';
import { attachmentsAfterSave, finishRuntime, type ComposePayload } from './composeRuntime.js';
import { hasLiveOpener, postToOpenerAndWait, trackPopout } from './popoutChannel.js';
import { hasQuotedOriginal } from '../editorExtensions.js';
import { COMPOSE_EDITOR_CLASS, QUOTE_FOLDED_CLASS, useComposeEditor } from '../../hooks/useComposeEditor.js';
import { useComposeSender } from '../../hooks/useComposeSender.js';
import { useComposeOriginal, useForwardAttachments } from '../../hooks/useComposeOriginal.js';
import { useComposeSignature } from '../../hooks/useComposeSignature.js';
import { useComposeDraft } from '../../hooks/useComposeDraft.js';
import { useUiPrefs, useUiStore, type ComposeAttachment, type ComposeContext, type ComposeSnapshot, type ComposeTabEntry } from '../../store/ui.js';
import { usePreferences, useRegional } from '../../store/preferences.js';
import { quoteMailHtml, textToQuotedHtml } from '../../lib/mailHtml.js';
import { replyThreading, safeLinkUrl } from '../../lib/compose.js';
import {
  buildQuoteHtml, isLongQuote, isReplyMode, quoteStartsFolded, quotedPart, subjectFor, textToParagraphsHtml,
} from '../../lib/composeQuote.js';
import { fromList, initialRecipients, recipientList, sendBlockers, type RecipientValue } from '../../lib/recipients.js';
import {
  addAttachments, composeFieldVisibility, dragHasFiles, draftStatusText, hasPendingChanges, initialFocus,
  inlineImageProblem, MAX_ATTACHMENTS,
} from '../../lib/composeRules.js';
import { formatBarVisible } from '../../lib/composeToolbar.js';
import { checkAccessibility, collectA11yItems, jumpTarget, type A11yIssue } from '../../lib/composeA11y.js';
import {
  MAX_NAME_CHECKS, applyNameCheck, nameCheckQuery, needsNameCheck, resolveRecipient,
  type DirectoryEntry, type NameCheckResult, type UnresolvedReason,
} from '../../lib/nameCheck.js';
import { dateTimeInsertOptions } from '../../lib/composeFormat.js';
import { api } from '../../api/client.js';
import { POPOUT_FEATURES, popoutUrl, popoutWindowName, sendMessage, type SendFlags } from '../../lib/composePopout.js';
import { toImportance, type Importance } from '../../lib/importance.js';
import { toSensitivity, type Sensitivity } from '../../lib/sensitivity.js';
import { isDraftAttachment } from '../../lib/draft-autosave.js';
import { deleteDraft, sendDraft, unsendDraft, type LoadedDraft, type SavedDraftResponse } from '../../lib/draft-api.js';
import { needsAttachmentReminder } from '../../lib/attachmentReminder.js';
import { receiptRequestOption } from '../../lib/readBehaviour.js';
import { formatLongDateTime, formatTime } from '../../lib/regionalFormat.js';
import { composeTextDefaults } from '../../lib/composeFonts.js';
import { OWN_MAILBOX, senderDraftFields, senderFromDraft, senderKey } from '../../lib/mailboxContext.js';
import { toastError } from '../../lib/errors.js';
import { fmt, useT } from '../../i18n/useT.js';

export type ComposeOutcome =
  | { kind: 'closed'; draftId: string | null; subject: string }
  | { kind: 'sent' } | { kind: 'scheduled' } | { kind: 'discarded' } | { kind: 'handedOff' } | { kind: 'poppedOut' }
  /** The draft is already open in a compose window (that window came to the front). */
  | { kind: 'elsewhere' };

export type ComposeVariant = 'inline' | 'window';

interface Props {
  tabKey: string;
  variant: ComposeVariant;
  /** Called after the compose was finished (the tab is gone). */
  onDone?: (outcome: ComposeOutcome) => void;
}

const ROOT_CLASS: Record<ComposeVariant, string> = {
  // < 768 px: full screen, above the top bar (z-50, later in the DOM); dialogs and menus stay above it
  inline: 'relative flex flex-col flex-1 min-w-0 min-h-0 bg-surface max-md:fixed max-md:inset-0 max-md:z-50',
  window: 'relative flex flex-col h-full min-h-0 bg-surface',
};

/** The compose area of one draft tab (nothing while the tab does not exist). */
export function ComposePane({ tabKey, variant, onDone }: Props) {
  const tab = useUiStore((s) => s.compose.tabs.find((t) => t.key === tabKey));
  if (!tab) return null;
  return <ComposeForm tab={tab} variant={variant} {...(onDone ? { onDone } : {})} />;
}

type ComposeDialog = { kind: 'options' } | { kind: 'a11y'; issues: A11yIssue[] };

interface ContactHit { displayName?: string | null; email?: string | null }

/** Address book entries for one "Namen prüfen" query (own contacts + directory). */
async function lookupRecipient(entry: string): Promise<DirectoryEntry[]> {
  const q = nameCheckQuery(entry);
  if (!q) return [];
  const hits = await api.get<ContactHit[]>(`/contacts?q=${encodeURIComponent(q)}`);
  return hits.map((h) => ({ displayName: h.displayName ?? '', email: h.email ?? '' }));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function ComposeForm({ tab, variant, onDone }: { tab: ComposeTabEntry; variant: ComposeVariant; onDone?: (o: ComposeOutcome) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const ui = useUiStore;
  const [ctx] = useState<ComposeContext>(tab.ctx);
  const restore = ctx.restore;
  const mode = ctx.mode;
  const mailbox = ctx.mailbox ?? OWN_MAILBOX;
  const bodyFromSnapshot = !!restore && !restore.bodyPending;
  const loadFromServer = !!ctx.draftId && !restore;

  const sender = useComposeSender(mailbox, restore ?? {});
  const composePrefs = usePreferences((s) => s.prefs.compose);
  const receiptOption = receiptRequestOption(usePreferences((s) => s.prefs.reading.requestReceipts));
  const regional = useRegional();
  const { sendDelaySec } = useUiPrefs();

  // ── Fields ─────────────────────────────────────────────────────────────────
  const [start] = useState(() => initialRecipients(mode, ctx, sender.ownAddresses));
  const [to, setTo] = useState<RecipientValue>(() => fromList(restore ? restore.to : start.to));
  const [cc, setCc] = useState<RecipientValue>(() => fromList(restore ? restore.cc : start.cc));
  const [bcc, setBcc] = useState<RecipientValue>(() => fromList(restore?.bcc ?? []));
  const [showCc, setShowCc] = useState(restore?.showCc ?? false);
  const [showBcc, setShowBcc] = useState(restore?.showBcc ?? false);
  const [subject, setSubject] = useState(restore?.subject ?? subjectFor(mode, ctx.subject));
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(restore?.attachments ?? []);
  const [plainText, setPlainText] = useState(restore?.plainText ?? composePrefs.format === 'plain');
  const [requestReceipt, setRequestReceipt] = useState(restore?.requestReceipt ?? receiptOption.checked);
  const [deliveryReceipt, setDeliveryReceipt] = useState(restore?.deliveryReceipt ?? false);
  const [importance, setImportance] = useState<Importance>(restore?.importance ?? 'normal');
  const [sensitivity, setSensitivity] = useState<Sensitivity>(restore?.sensitivity ?? 'normal');
  const [showFrom, setShowFrom] = useState(restore?.showFrom ?? false);
  const [quoteFolded, setQuoteFolded] = useState(restore?.quoteFolded ?? false);
  const [scheduling, setScheduling] = useState(false);
  const [checkingNames, setCheckingNames] = useState(false);
  const [unresolved, setUnresolved] = useState<Record<string, UnresolvedReason>>({});
  const [dragging, setDragging] = useState(false);
  const [popover, setPopover] = useState<{ kind: 'schedule' | 'emoji'; anchor: HTMLElement } | null>(null);
  const [dialog, setDialog] = useState<ComposeDialog | null>(null);
  const [linkDialog, setLinkDialog] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const threading = useRef<{ inReplyTo?: string; references?: string }>(restore?.threading ?? {});
  const recipientsTouched = useRef(!!restore);
  const bodyBuilt = useRef(bodyFromSnapshot || loadFromServer);
  const draftLoaded = useRef(!loadFromServer);
  const busyAction = useRef(false);
  const lastHtml = useRef(restore?.bodyHtml ?? '');
  const refs = { to: useRef<HTMLInputElement>(null), cc: useRef<HTMLInputElement>(null), bcc: useRef<HTMLInputElement>(null) };
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const insertImageRef = useRef<(file: File) => void>(() => undefined);

  const editor = useComposeEditor({
    label: t('compose_body'), placeholder: t('compose_body_placeholder'), onPasteImage: (f) => insertImageRef.current(f),
  });
  const { original, originalId, loading: originalLoading } = useComposeOriginal({ mode, id: ctx.id, mailbox });

  const editorHtml = () => {
    if (editor && !editor.isDestroyed) lastHtml.current = editor.getHTML();
    return lastHtml.current;
  };
  const editorText = () => (editor && !editor.isDestroyed ? editor.getText({ blockSeparator: '\n' }) : '');

  // ── Server draft ─────────────────────────────────────────────────────────────
  const payload = (): ComposePayload => {
    // Threading: the original's Message-ID (+ References); the internal id only when it has none / did not load
    let th = threading.current;
    if (isReplyMode(mode) && ctx.id) th = original ? replyThreading(original) : { inReplyTo: ctx.id };
    return {
      to: recipientList(to),
      cc: recipientList(cc),
      bcc: recipientList(bcc),
      subject,
      // 9.4: plain-text format sends the text only
      bodyHtml: plainText ? '' : editorHtml(),
      bodyText: editorText(),
      ...(th.inReplyTo ? { inReplyTo: th.inReplyTo } : {}),
      ...(th.references ? { references: th.references } : {}),
      ...senderDraftFields(sender.selected),
      importance,
      sensitivity,
      keepAttachmentIds: attachments.filter(isDraftAttachment).map((a) => a.id),
      files: attachments.filter((a): a is File => !isDraftAttachment(a)),
      snapshot: [...attachments],
    };
  };

  const snapshot = (forwardPending = false): ComposeSnapshot => ({
    to: recipientList(to), cc: recipientList(cc), bcc: recipientList(bcc), subject,
    bodyHtml: editorHtml(), attachments: [...attachments],
    showCc, showBcc, fromKey: sender.fromKey, draftSender: sender.draftSender,
    requestReceipt, deliveryReceipt, importance, sensitivity, showFrom, plainText, quoteFolded, signature: signature.state(), threading: threading.current,
    ...(bodyBuilt.current ? {} : { bodyPending: true }),
    ...(forwardPending ? { forwardPending: true } : {}),
  });

  const onLoaded = (d: LoadedDraft) => {
    draftLoaded.current = true;
    setTo(fromList(d.to));
    setCc(fromList(d.cc));
    setBcc(fromList(d.bcc));
    setShowCc(d.cc.length > 0);
    setShowBcc(d.bcc.length > 0);
    setSubject(d.subject);
    setAttachments(d.attachments);
    threading.current = {
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
      ...(d.references.length ? { references: d.references.join(' ') } : {}),
    };
    // sender of the reopened draft (own address when it has none)
    const fromDraft = senderFromDraft(d.sendAs, d.sendOnBehalfOf, sender.ownEmail);
    sender.setDraftSender(fromDraft);
    sender.setFromKey(fromDraft ? senderKey(fromDraft) : 'self:');
    setImportance(toImportance(d.importance));
    setSensitivity(toSensitivity(d.sensitivity));
    if (!d.bodyHtml && d.bodyText) setPlainText(true);
    editor?.commands.setContent(d.bodyHtml || textToParagraphsHtml(d.bodyText));
    setQuoteFolded(!!d.inReplyTo && isLongQuote(quotedPart(d.bodyHtml)));
    focusInitial(d.to.length);
  };

  const onSaved = (saved: SavedDraftResponse, state: ComposePayload) => {
    setAttachments((cur) => {
      const r = attachmentsAfterSave(cur, state, saved);
      if (r.lost > 0) toast.error(fmt(t('compose_draft_attach_lost'), { n: r.lost }));
      return r.list;
    });
    ui.getState().updateComposeTab(tab.key, { draftId: saved.id });
    void qc.invalidateQueries({ queryKey: ['messages'] });
  };

  const forwardLoadingRef = useRef(false);
  const { runtime, saveInfo, draftLoading } = useComposeDraft({
    tabKey: tab.key, ctx, editor, loadFromServer, payload,
    // 9.4: a draft open in a compose window is not opened inline a second time
    ...(variant === 'inline' ? { onElsewhere: () => { toast(t('compose_open_elsewhere')); end({ kind: 'elsewhere' }); } } : {}),
    freeze: () => (draftLoaded.current ? snapshot(forwardLoadingRef.current) : null),
    onLoaded, onSaved,
  });
  const saver = runtime.saver;
  const touch = () => saver.touch();

  // ── Body ─────────────────────────────────────────────────────────────────────
  const quoteHtml = () => {
    if (mode === 'new') return '';
    const body = ctx.bodyHtml || (original ? (original.bodyHtml || textToQuotedHtml(original.bodyText ?? '')) : '');
    if (!body) return '';
    // Sender, recipients, subject and body of the original are untrusted: escaped / sanitised
    return buildQuoteHtml({
      fromAddr: original?.fromAddr ?? ctx.fromAddr ?? '',
      fromName: original?.fromName ?? ctx.fromName,
      date: original?.date ?? ctx.date,
      toAddrs: original?.toAddrs ?? ctx.toAddrs,
      ccAddrs: original?.ccAddrs ?? ctx.ccAddrs,
      subject: original?.subject ?? ctx.subject,
    }, quoteMailHtml(body), {
      from: t('compose_q_from'), sent: t('compose_q_sent'), to: t('compose_q_to'), cc: t('compose_q_cc'), subject: t('compose_q_subject'),
    }, (d) => formatLongDateTime(d, regional));
  };
  const waiting = (!!originalId && originalLoading) || sender.pending;
  const signature = useComposeSignature({
    editor,
    build: bodyFromSnapshot || loadFromServer ? 'never' : (waiting ? 'wait' : 'now'),
    replyOrForward: mode !== 'new',
    signatureKey: sender.signatureKey,
    quoteHtml,
    fontDefaults: composeTextDefaults(composePrefs),
    initial: restore?.signature,
    onBuilt: (quote) => {
      bodyBuilt.current = true;
      setQuoteFolded(quoteStartsFolded(mode, quote));
      focusInitial();
    },
  });

  // Snapshot (tab switch, undo send): its body as it was
  const snapshotApplied = useRef(false);
  useEffect(() => {
    if (!editor || !bodyFromSnapshot || snapshotApplied.current || !restore) return;
    snapshotApplied.current = true;
    editor.commands.setContent(restore.bodyHtml);
    editor.commands.focus('start');
  }, [editor]);

  const forwardLoading = useForwardAttachments({
    enabled: mode === 'forward' && (!restore || !!restore.forwardPending),
    original,
    add: (files) => setAttachments((prev) => addAttachments([], [...files, ...prev]).list),
  });
  forwardLoadingRef.current = forwardLoading;

  // Reply (all): An / Cc again once the original (the list has no Cc) or the own address is known
  const ownKey = sender.ownAddresses.join(',');
  useEffect(() => {
    if (!isReplyMode(mode) || restore || recipientsTouched.current) return;
    const r = initialRecipients(mode, original ?? ctx, sender.ownAddresses);
    setTo(fromList(r.to));
    setCc(fromList(r.cc));
  }, [original, ownKey]);

  // The tab strip and an own window show the subject as typed
  useEffect(() => { ui.getState().updateComposeTab(tab.key, { subject }); }, [subject]);

  function focusInitial(toCount = recipientList(to).length) {
    requestAnimationFrame(() => {
      if (initialFocus(mode, toCount) === 'to') refs.to.current?.focus();
      else editor?.commands.focus('start');
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────────
  const busy = forwardLoading || draftLoading || scheduling;
  const blockers = sendBlockers({ to, cc, bcc });
  const canSend = !busy && !blockers.missingTo;
  const invalidateMail = () => {
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
  };
  const announce = (text: string) => setAnnouncement(text);

  /** Saves the current state as the server draft (forced) and returns its id. */
  const saveNow = async (): Promise<string> => {
    saver.touch();
    const id = await saver.flush();
    if (!id) throw new Error(t('draft_save_failed'));
    return id;
  };

  const returnFocus = () => {
    if (variant === 'window') return;
    const el = runtime.returnFocus;
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus();
      else document.querySelector<HTMLElement>('[data-coremail-toolbar] [data-roving-stop]')?.focus();
    });
  };

  /** The tab is done: no more saving, the compose area goes away. */
  const end = (outcome: ComposeOutcome) => {
    finishRuntime(tab.key);
    ui.getState().closeCompose(tab.key);
    returnFocus();
    onDone?.(outcome);
  };

  /** Checks before a send; false = do not send. */
  const readyToSend = (): boolean => {
    if (!canSend || busyAction.current || runtime.finished) return false;
    if (blockers.invalid.length) {
      toast.error(fmt(t('compose_invalid_recipients'), { list: blockers.invalid.slice(0, 3).join(', ') }));
      return false;
    }
    const forgotten = needsAttachmentReminder(composePrefs.attachmentReminder, attachments.length, subject, editorHtml());
    return !forgotten || window.confirm(fmt(t('compose_attachment_reminder'), { word: forgotten }));
  };
  const sendFlags = (): SendFlags => ({ requestReceipt: requestReceipt && receiptOption.visible, requestDeliveryReceipt: deliveryReceipt });
  const sendOptions = () => {
    const f = sendFlags();
    return { ...(f.requestReceipt ? { requestReceipt: true } : {}), ...(f.requestDeliveryReceipt ? { requestDeliveryReceipt: true } : {}) };
  };

  /**
   * Senden / Ctrl+Enter: the mail is saved as a server draft and handed to the
   * server with the undo hold (Settings → Ansicht, default 10 s) — sent even if
   * this tab is closed. Undo reopens the draft. In its own window the send is
   * handed to the main window (its undo toast) and the window closes.
   */
  const send = () => {
    if (!readyToSend()) return;
    if (variant === 'window' && hasLiveOpener()) { void handOffSend(); return; }
    sendHere();
  };

  const sendHere = () => {
    const restoreSnapshot = snapshot();
    const baseCtx = ctx;
    queueHeldSend({
      delaySec: sendDelaySec,
      start: async () => {
        const id = await saveNow();
        await sendDraft(id, { undoDelaySec: sendDelaySec, ...sendOptions() });
        return id;
      },
      undo: (id) => unsendDraft(id),
      reopenAfterUndo: (id) => ({ mode: 'new', draftId: id, mailbox }),
      reopenOnError: () => ({ ...baseCtx, restore: restoreSnapshot, ...(saver.draftId ? { draftId: saver.draftId } : {}) }),
      onSent: invalidateMail,
    });
    // the draft is in the Drafts folder now; the list shows it until it is sent
    setTimeout(invalidateMail, 1500);
    end({ kind: 'sent' });
  };

  /**
   * Own window: the main window sends (and answers `accepted`). Without an
   * answer — main window reloaded, busy or gone — this window sends itself;
   * the server's send claim keeps it to one send either way.
   */
  const handOffSend = async () => {
    busyAction.current = true;
    try {
      const id = await saveNow();
      if (await postToOpenerAndWait(sendMessage(id, sendFlags(), mailbox))) { end({ kind: 'handedOff' }); return; }
    } catch (err) {
      toastError(err);
      return;
    } finally {
      busyAction.current = false;
    }
    sendHere();
  };

  const schedule = async (date: Date) => {
    setPopover(null);
    if (!readyToSend()) return;
    busyAction.current = true;
    setScheduling(true);
    try {
      const id = await saveNow();
      await sendDraft(id, { scheduledAt: date.toISOString(), ...sendOptions() });
      toast.success(fmt(t('compose_scheduled'), { date: formatLongDateTime(date, regional) }));
      invalidateMail();
      end({ kind: 'scheduled' });
    } catch (err) {
      toastError(err);
    } finally {
      busyAction.current = false;
      setScheduling(false);
    }
  };

  const discard = async () => {
    if (!window.confirm(t('draft_discard_confirm'))) return;
    runtime.finished = true;
    saver.dispose();                    // no further autosave
    try {
      // a save may be running: wait for its result to know the latest version
      const id = saver.draftId || saver.status === 'saving' ? await saver.flush().catch(() => saver.draftId) : null;
      if (id) await deleteDraft(id);
      saver.forget();
      toast(t('draft_discarded'), { duration: 3000 });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      end({ kind: 'discarded' });
    } catch (err) {
      runtime.finished = false;
      toastError(err);
    }
  };

  /** ✕ / Esc: saves and closes; asks only when the draft cannot be saved. */
  const close = async () => {
    if (busyAction.current) return;
    busyAction.current = true;
    const pending = hasPendingChanges(saver.status);
    try {
      await saver.flush();
    } catch {
      if (!window.confirm(t('compose_close_unsaved'))) { busyAction.current = false; return; }
    }
    saver.dispose();
    if (pending && saver.draftId) toast.success(t('draft_saved_closed'));
    end({ kind: 'closed', draftId: saver.draftId, subject });
  };

  const saveDraftNow = () => {
    saver.touch();
    // the reason (e.g. too large) is shown, not only that it failed
    saver.flush().then(() => toast.success(t('draft_saved_closed')), toastError);
  };

  /** "In neuem Fenster öffnen": save, open /compose/<id>, close the inline compose. */
  const popOut = async () => {
    // opened inside the click (popup blockers), pointed at the draft once it is saved
    const win = window.open('', popoutWindowName(tab.key), POPOUT_FEATURES);
    if (!win) { toast.error(t('compose_popout_blocked')); return; }
    busyAction.current = true;
    try {
      const id = await saveNow();
      saver.dispose();
      trackPopout(win);
      win.location.replace(popoutUrl(id, mailbox));
      end({ kind: 'poppedOut' });
    } catch (err) {
      win.close();
      toastError(err);
    } finally {
      busyAction.current = false;
    }
  };

  const togglePlain = () => {
    if (!plainText) {
      const text = editorText();
      if (text.trim() && !window.confirm(t('compose_plain_confirm'))) return;
      editor?.commands.setContent(textToParagraphsHtml(text));
      setQuoteFolded(false);
    }
    setPlainText((v) => !v);
    touch();
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const r = addAttachments(attachments, files, MAX_ATTACHMENTS);
    if (r.rejected) toast.error(fmt(t('compose_too_many_attachments'), { max: MAX_ATTACHMENTS, n: r.rejected }));
    setAttachments(r.list);
    touch();
  };

  const insertImage = (file: File) => {
    if (plainText) return;              // plain text carries no pictures (attach the file instead)
    const problem = inlineImageProblem(file);
    if (problem) { toast.error(t(problem === 'type' ? 'compose_image_type' : 'compose_image_size')); return; }
    readFileAsDataUrl(file).then((src) => {
      if (src) editor?.chain().focus().setImage({ src }).run();
    }, toastError);
  };
  insertImageRef.current = insertImage;

  const applyLink = (url: string) => {
    const href = safeLinkUrl(url);
    if (!href || !editor) return;
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: url.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setLinkDialog(null);
  };
  const openLink = () => setLinkDialog((editor?.getAttributes('link')['href'] as string | undefined) ?? 'https://');

  /**
   * "Namen prüfen": every entry that is not yet "Name <address>" is looked up
   * in the address book (lib/nameCheck.ts); unresolved ones are marked.
   */
  const checkNames = async () => {
    const fields = [[to, setTo], [cc, setCc], [bcc, setBcc]] as const;
    const lists = fields.map(([v]) => recipientList(v));
    const pending = [...new Set(lists.flat().filter(needsNameCheck))].slice(0, MAX_NAME_CHECKS);
    setCheckingNames(true);
    try {
      const found = new Map(await Promise.all(pending.map(async (e) => [e, await lookupRecipient(e)] as const)));
      const marked: Record<string, UnresolvedReason> = {};
      fields.forEach(([, set], i) => {
        const results = lists[i]!.map((e): NameCheckResult => {
          const hits = found.get(e);
          return hits ? resolveRecipient(e, hits) : { kind: 'known', entry: e };
        });
        const r = applyNameCheck(results);
        Object.assign(marked, r.unresolved);
        set(fromList(r.entries));
      });
      setUnresolved(marked);
      recipientsTouched.current = true;
      touch();
      const open = Object.keys(marked);
      const text = open.length ? fmt(t('compose_names_unresolved'), { list: open.join(', ') }) : t('compose_names_ok');
      announce(text);
      if (open.length) toast.error(text); else toast.success(text);
    } catch (err) {
      toastError(err);
    } finally {
      setCheckingNames(false);
    }
  };

  const openAccessibilityCheck = () => {
    if (!editor) return;
    setDialog({ kind: 'a11y', issues: checkAccessibility(collectA11yItems(editor.state.doc)) });
  };

  /** "Anzeigen" of an accessibility issue: the dialog closes, the cursor goes there. */
  const showIssue = (issue: A11yIssue) => {
    setDialog(null);
    const target = jumpTarget(issue);
    // after the dialog has handed focus back to its opener
    requestAnimationFrame(() => {
      if (!editor || editor.isDestroyed) return;
      const pos = Math.min(target.pos, editor.state.doc.content.size);
      const chain = editor.chain().focus();
      (target.select === 'node' ? chain.setNodeSelection(pos) : chain.setTextSelection(pos)).scrollIntoView().run();
    });
  };

  const applyOptions = (o: MessageOptions) => {
    setDialog(null);
    setSensitivity(o.sensitivity);
    setRequestReceipt(o.requestReceipt);
    setDeliveryReceipt(o.deliveryReceipt);
    touch();
  };

  const commandActions: ComposeCommandActions = {
    send,
    openSchedule: (anchor) => setPopover({ kind: 'schedule', anchor }),
    discard: () => { void discard(); },
    attachFile: () => fileInput.current?.click(),
    insertImage: () => imageInput.current?.click(),
    openEmoji: (anchor) => setPopover({ kind: 'emoji', anchor }),
    pickSignature: (id) => { signature.pick(id); touch(); },
    dateTimes: () => dateTimeInsertOptions(new Date(), regional).map((o) => o.text),
    insertText: (text) => { editor?.chain().focus().insertContent(text).run(); },
    saveDraft: saveDraftNow,
    toggleFrom: () => { setShowFrom((v) => !v); },
    checkNames: () => { void checkNames(); },
    setImportance: (level) => { setImportance(level); touch(); },
    togglePlain,
    openOptions: () => setDialog({ kind: 'options' }),
    checkAccessibility: openAccessibilityCheck,
    popOut: () => { void popOut(); },
    close: () => { void close(); },
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // keys typed in the link dialog (a portal) bubble here too
    if (isModalOpen()) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented && !popover) { e.preventDefault(); void close(); }
  };

  const edited = <V,>(setter: (v: V) => void, recipients = false) => (v: V) => {
    setter(v);
    if (recipients) recipientsTouched.current = true;
    touch();
  };

  // ── View ─────────────────────────────────────────────────────────────────────
  const visibility = composeFieldVisibility({
    senderCount: sender.choices.length, showFrom, showCc, showBcc, ccCount: recipientList(cc).length, bccCount: recipientList(bcc).length,
  });
  const status = draftStatusText(saveInfo.status, saveInfo.savedAt, draftLoading);
  const statusText = status.kind === 'loading' ? t('compose_loading')
    : status.kind === 'saving' ? t('draft_saving')
      : status.kind === 'failed' ? t('draft_save_failed')
        : status.kind === 'locked' ? t('draft_locked')
          : status.kind === 'savedAt' ? fmt(t('draft_saved_at'), { time: formatTime(status.at, regional) }) : '';
  const sendBlockedReason = busy ? t('compose_send_busy') : blockers.missingTo ? t('compose_send_need_to') : undefined;
  const quoteShown = hasQuotedOriginal(editor);
  const commandState: ComposeCommandState = {
    canSend, sendBlockedReason, plainText, importance, signatures: signature.signatures,
    fromShown: visibility.from, fromAutomatic: visibility.fromAutomatic, checkingNames,
    emojiOpen: popover?.kind === 'emoji', inWindow: variant === 'window',
  };

  return (
    <section
      aria-label={fmt(t('compose_region'), { subject: subject.trim() || t('compose_new_message') })}
      data-shortcut-scope="compose"
      onKeyDown={onKeyDown}
      onDragEnter={(e) => { if (dragHasFiles(e.dataTransfer?.types)) { e.preventDefault(); setDragging(true); } }}
      onDragOver={(e) => { if (dragHasFiles(e.dataTransfer?.types)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        if (!dragHasFiles(e.dataTransfer?.types)) return;
        e.preventDefault();
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
      className={ROOT_CLASS[variant]}
    >
      <ComposeCommandRow state={commandState} actions={commandActions} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ComposeFields
          visibility={visibility}
          senders={sender.choices}
          sender={sender.selected}
          onSender={(key) => { sender.setFromKey(key); touch(); }}
          to={to} cc={cc} bcc={bcc}
          onTo={edited(setTo, true)} onCc={edited(setCc, true)} onBcc={edited(setBcc, true)}
          onShowCc={() => { setShowCc(true); requestAnimationFrame(() => refs.cc.current?.focus()); }}
          onShowBcc={() => { setShowBcc(true); requestAnimationFrame(() => refs.bcc.current?.focus()); }}
          subject={subject}
          onSubject={edited(setSubject)}
          onAnnounce={announce}
          unresolved={unresolved}
          refs={refs}
        />
        <div className="px-3 py-2 space-y-2 border-b border-line">
          <p role="status" aria-live="polite" className={`text-xs min-h-[1rem] flex items-center gap-1.5 ${status.kind === 'failed' ? 'text-danger-fg' : 'text-fg-subtle'}`}>
            {(status.kind === 'loading' || busy) && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {statusText}
          </p>
          <AttachmentChips attachments={attachments} onRemove={(i) => { setAttachments((prev) => prev.filter((_, idx) => idx !== i)); touch(); }} />
        </div>
        <div className="relative">
          {editor?.isEmpty && (
            <p aria-hidden="true" className="absolute left-4 top-3 text-sm text-fg-subtle pointer-events-none select-none">
              {t('compose_body_placeholder')}
            </p>
          )}
          <EditorContent editor={editor} className={`${COMPOSE_EDITOR_CLASS} ${quoteFolded ? QUOTE_FOLDED_CLASS : ''}`} />
        </div>
        {quoteShown && (
          <div className="px-4 pb-4">
            <button
              type="button"
              aria-expanded={!quoteFolded}
              onClick={() => setQuoteFolded((v) => !v)}
              title={t(quoteFolded ? 'compose_quote_show' : 'compose_quote_hide')}
              aria-label={t(quoteFolded ? 'compose_quote_show' : 'compose_quote_hide')}
              className="px-2 py-0.5 rounded border border-line-strong text-fg-muted hover:bg-surface-2 text-sm leading-none"
            >
              …
            </button>
          </div>
        )}
      </div>
      {formatBarVisible(plainText) && (
        <ComposeFormatBar
          editor={editor}
          defaultSize={composeTextDefaults(composePrefs).fontSize}
          actions={{ openLink, insertImage: commandActions.insertImage }}
        />
      )}
      <ComposeActionBar state={commandState} actions={commandActions} />

      {dragging && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface/90 border-2 border-dashed border-accent-fg pointer-events-none">
          <p className="flex items-center gap-2 text-sm font-medium text-accent-fg"><Paperclip size={16} aria-hidden="true" /> {t('compose_drop')}</p>
        </div>
      )}
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ''; }} />
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>

      {popover?.kind === 'schedule' && (
        <SchedulePopover anchor={popover.anchor} onSchedule={(d) => { void schedule(d); }} onClose={() => setPopover(null)} />
      )}
      {popover?.kind === 'emoji' && (
        <EmojiPopover
          anchor={popover.anchor}
          onPick={(emoji) => { setPopover(null); editor?.chain().focus().insertContent(emoji).run(); }}
          onClose={() => setPopover(null)}
        />
      )}
      {linkDialog !== null && (
        <PromptDialog
          title={t('compose_link_title')}
          label={t('compose_link_label')}
          initialValue={linkDialog}
          confirmText={t('compose_link_apply')}
          cancelText={t('cancel')}
          validate={(v) => (safeLinkUrl(v) ? null : t('compose_link_invalid'))}
          requiredText={t('compose_link_invalid')}
          onConfirm={applyLink}
          onCancel={() => { setLinkDialog(null); editor?.commands.focus(); }}
        />
      )}
      {dialog?.kind === 'options' && (
        <MessageOptionsDialog
          initial={{ sensitivity, requestReceipt, deliveryReceipt }}
          receiptVisible={receiptOption.visible}
          onApply={applyOptions}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'a11y' && (
        <AccessibilityDialog issues={dialog.issues} onShow={showIssue} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}
