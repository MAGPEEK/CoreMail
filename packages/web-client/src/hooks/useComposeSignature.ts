/**
 * Body of a new compose and its signature (9.4): builds the start body once the
 * editor, the named signatures and (reply / forward) the original are there —
 * an empty line, the default signature of the identity and kind, the quote.
 * A sender change swaps the signature while the block is unchanged
 * (`mayAutoSwapSignature`); the picker puts any signature (or none) in place.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Editor } from '@tiptap/react';
import { api } from '../api/client.js';
import { replaceSignatureBlock, signatureBlockState } from '../components/editorExtensions.js';
import {
  defaultSignatureHtml, mayAutoSwapSignature, signatureBlockHtml, type NamedSignature, type SignatureDefaults,
} from '../lib/signaturePick.js';
import { initialBodyHtml } from '../lib/composeQuote.js';
import { useWebmailFeatures } from './useWebmailFeatures.js';

export interface SignatureState { forKey: string | null; inserted: string | null | undefined }

export interface SignatureList { signatures: NamedSignature[]; defaults: Record<string, SignatureDefaults> }

/** 9.4: with the signatures module off (webmail policy) compose works without any signature. */
const NO_SIGNATURES: SignatureList = Object.freeze({ signatures: [], defaults: {} }) as SignatureList;

export function useSignatures() {
  const enabled = useWebmailFeatures().features.signatures;
  const data = useQuery({
    queryKey: ['user', 'signatures'],
    queryFn: () => api.get<SignatureList>('/user/signatures'),
    enabled,
  }).data;
  return enabled ? data : NO_SIGNATURES;
}

export function useComposeSignature(o: {
  editor: Editor | null;
  /** now = build the body; wait = inputs still loading; never = the body comes from a draft / snapshot */
  build: 'now' | 'wait' | 'never';
  replyOrForward: boolean;
  signatureKey: string;
  quoteHtml: () => string;
  fontDefaults: { fontFamily: string; fontSize: string };
  initial: SignatureState | undefined;
  onBuilt: (quoteHtml: string) => void;
}) {
  const sigData = useSignatures();
  const built = useRef(false);
  /** Identity whose signature was placed (null = none yet) and the block as placed (undefined = unknown). */
  const forKey = useRef<string | null>(o.initial?.forKey ?? null);
  const inserted = useRef<string | null | undefined>(o.initial?.inserted);
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    const { editor } = latest.current;
    if (!editor || built.current || o.build !== 'now' || !sigData) return;
    built.current = true;
    const cur = latest.current;
    const sig = signatureBlockHtml(defaultSignatureHtml(sigData.signatures, sigData.defaults, cur.signatureKey, cur.replyOrForward));
    const quote = cur.quoteHtml();
    const html = initialBodyHtml(sig, quote);
    if (html) editor.commands.setContent(html);
    // default font / size for what the user types (Settings → Verfassen)
    const style = {
      ...(cur.fontDefaults.fontFamily ? { fontFamily: cur.fontDefaults.fontFamily } : {}),
      ...(cur.fontDefaults.fontSize ? { fontSize: cur.fontDefaults.fontSize } : {}),
    };
    const chain = editor.chain().focus('start');
    (Object.keys(style).length > 0 ? chain.setMark('textStyle', style) : chain).run();
    inserted.current = signatureBlockState(editor);
    forKey.current = cur.signatureKey;
    cur.onBuilt(quote);
  }, [o.editor, o.build, sigData]);

  // Another sender → that identity's default signature, unless the block was changed
  useEffect(() => {
    const { editor } = o;
    if (!editor || !sigData || forKey.current === null || forKey.current === o.signatureKey) return;
    forKey.current = o.signatureKey;
    if (!mayAutoSwapSignature(signatureBlockState(editor), inserted.current)) return;
    replaceSignatureBlock(editor, defaultSignatureHtml(sigData.signatures, sigData.defaults, o.signatureKey, o.replyOrForward));
    inserted.current = signatureBlockState(editor);
  }, [o.editor, sigData, o.signatureKey, o.replyOrForward]);

  /** Picker: the chosen signature (or none, id '') in place of the current one. */
  const pick = (id: string) => {
    const { editor } = o;
    if (!editor || !sigData) return;
    replaceSignatureBlock(editor, id ? (sigData.signatures.find((s) => s.id === id)?.html ?? '') : '');
    inserted.current = signatureBlockState(editor);
    forKey.current ??= o.signatureKey;
  };

  const state = (): SignatureState => ({ forKey: forKey.current, inserted: inserted.current });
  return { signatures: sigData?.signatures ?? [], pick, state };
}
