/**
 * Web chat pending-feedback integration tests.
 *
 * These tests load the real client code in `web/app.js` against a minimal DOM
 * shim and drive the actual `sendMessage` flow through a mockable `fetch`.
 * They verify rendered behavior (DOM mutations), not static source strings:
 *
 *   1. User message appears immediately, before the API call resolves.
 *   2. Pending indicator (typing state) is visible while the request is unresolved.
 *   3. Composer (send button + input) is disabled while pending.
 *   4. Duplicate submissions are prevented while pending.
 *   5. Successful response removes pending state and renders the assistant reply.
 *   6. Failed request renders a clear error and restores the composer.
 *   7. Accessibility roles and live announcements are present.
 *
 * No live network, SMS, or voice is used.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';

// ─── Minimal DOM shim sufficient to exercise web/app.js ──────────────────────

class ClassList {
  private el: HTMLElement;
  private set = new Set<string>();
  constructor(el: HTMLElement) { this.el = el; }
  add(...c: string[]) { c.forEach((x) => this.set.add(x)); this.el._syncClass(); }
  remove(...c: string[]) { c.forEach((x) => this.set.delete(x)); this.el._syncClass(); }
  contains(c: string) { return this.set.has(c); }
  get value() { return Array.from(this.set).join(' '); }
}

class TextNode {
  textContent: string;
  constructor(t: string) { this.textContent = t; }
}

class HTMLElement {
  tagName: string;
  children: Array<HTMLElement | TextNode> = [];
  attributes: Record<string, string> = {};
  classList: ClassList;
  _class = '';
  id = '';
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  value = '';
  parent: HTMLElement | null = null;
  eventListeners: Record<string, Array<(e: any) => void>> = {};
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.classList = new ClassList(this);
  }
  _syncClass() { this._class = this.classList.value; if (this._class) this.attributes['class'] = this._class; else delete this.attributes['class']; }
  setAttribute(k: string, v: string) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    else if (k === 'class') { this.classList = new ClassList(this); String(v).split(/\s+/).filter(Boolean).forEach((x) => this.classList.add(x)); }
    this._syncClass();
  }
  removeAttribute(k: string) { delete this.attributes[k]; if (k === 'class') { this.classList = new ClassList(this); this._class = ''; } else if (k === 'id') this.id = ''; }
  getAttribute(k: string) { return k in this.attributes ? this.attributes[k] : null; }
  hasAttribute(k: string) { return k in this.attributes; }
  append(...nodes: Array<string | HTMLElement | TextNode>) {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push(new TextNode(n));
      else { this.children.push(n); n.parent = this; }
    }
    return this;
  }
  appendChild(n: HTMLElement | TextNode) { this.children.push(n); n.parent = this; return n; }
  createElement(tag: string): HTMLElement { return new HTMLElement(tag); }
  replaceChildren(...nodes: Array<string | HTMLElement | TextNode>) { this.children = []; this.append(...nodes); }
  querySelector(sel: string): HTMLElement | null { return this._matchAll(sel, true)[0] ?? null; }
  querySelectorAll(sel: string): HTMLElement[] { return this._matchAll(sel, false); }
  private _matchAll(sel: string, firstOnly: boolean): HTMLElement[] {
    const all: HTMLElement[] = [];
    const collect = (node: HTMLElement) => {
      for (const child of node.children) {
        if (child instanceof HTMLElement) { all.push(child); collect(child); }
      }
    };
    collect(this);
    const result: HTMLElement[] = [];
    for (const el of all) {
      if (this._matches(el, sel)) { result.push(el); if (firstOnly && result.length) break; }
    }
    return result;
  }
  private _matches(el: HTMLElement, sel: string): boolean {
    let tagMatch = true;
    let rest = sel;
    const m = sel.match(/^([a-zA-Z]+)(.*)$/);
    if (m) { tagMatch = el.tagName === m[1].toUpperCase(); rest = m[2]; }
    if (rest.startsWith('#')) { if (el.id !== rest.slice(1)) return false; rest = ''; }
    for (const cp of rest.split('.').filter(Boolean)) { if (!el.classList.contains(cp)) return false; }
    const attrMatches = rest.match(/\[([^\]]+)\]/g);
    if (attrMatches) {
      for (const am of attrMatches) {
        const inner = am.slice(1, -1);
        const eq = inner.indexOf('=');
        if (eq === -1) { if (!el.hasAttribute(inner)) return false; }
        else { const k = inner.slice(0, eq); const v = inner.slice(eq + 1).replace(/^"|"$/g, ''); if (el.getAttribute(k) !== v) return false; }
      }
    }
    return tagMatch;
  }
  addEventListener(type: string, fn: (e: any) => void) { (this.eventListeners[type] = this.eventListeners[type] || []).push(fn); }
  removeEventListener() { /* noop */ }
  dispatchEvent(evt: any) { const type = evt.type || evt; (this.eventListeners[type] || []).forEach((fn) => fn(evt)); return true; }
  focus() { /* noop */ }
  click() { this.dispatchEvent({ type: 'click', preventDefault() { /* noop */ } }); }
  requestSubmit() { this.dispatchEvent({ type: 'submit', preventDefault() { /* noop */ }, defaultPrevented: false }); }
}

Object.defineProperty(HTMLElement.prototype, 'className', {
  get() { return this.classList.value; },
  set(v: string) { this.classList = new ClassList(this); String(v).split(/\s+/).filter(Boolean).forEach((x) => this.classList.add(x)); this._syncClass(); },
  configurable: true, enumerable: true,
});

Object.defineProperty(HTMLElement.prototype, 'textContent', {
  get() {
    let s = this._ownText == null ? '' : String(this._ownText);
    for (const c of this.children) { s += c instanceof TextNode ? c.textContent : c.textContent; }
    return s;
  },
  set(v: string) { this._ownText = String(v); },
  configurable: true, enumerable: true,
});

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = new HTMLElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// ─── Test harness ────────────────────────────────────────────────────────────

let deferredResolve: ((r: any) => void) | null = null;
let deferredPromise: Promise<any> | null = null;

function startDeferredMessageFetch() {
  deferredResolve = null;
  deferredPromise = new Promise<any>((res) => { deferredResolve = res; });
}
function resolveDeferredMessageFetch(response: any) {
  if (deferredResolve) { deferredResolve(response); deferredResolve = null; deferredPromise = null; }
}

function setFetchResponse(response: any | 'deferred') {
  globalThis.fetch = vi.fn(async (path: string) => {
    const p = String(path);
    if (p.includes('/web/session')) return { ok: false, status: 401, json: async () => ({ error: 'INVALID_SESSION' }) };
    if (p.includes('/web/projects')) return { ok: true, status: 200, json: async () => [] };
    if (p.includes('/web/message')) {
      if (response === 'deferred') return deferredPromise!;
      return response;
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  });
}

function buildDocument(): HTMLElement {
  const doc: any = new HTMLElement('#document');
  const messageList = el('div', { id: 'message-list', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Chat messages' });
  const typingState = el('div', { id: 'typing-state', class: 'typing-state hidden', role: 'status', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  const messageForm = el('form', { id: 'message-form', class: 'composer', 'aria-label': 'Message composer' });
  const messageInput = el('textarea', { id: 'message-input', rows: '1', 'aria-label': 'Message', autocomplete: 'off' });
  const sendButton = el('button', { id: 'send-button', class: 'send-button', type: 'submit', 'aria-label': 'Send message' });
  messageForm.append(messageInput, sendButton);
  doc.append(messageList, typingState, messageForm, el('div', { id: 'user-initials' }), el('div', { id: 'login-view' }), el('form', { id: 'login-form' }), el('div', { id: 'chat-view', class: 'chat-view hidden' }), el('div', { id: 'project-select' }), el('button', { id: 'logout-button' }), el('button', { id: 'mobile-menu' }), el('button', { id: 'overview-nav', class: 'conversation-item' }), el('button', { id: 'chat-nav', class: 'conversation-item' }), el('button', { id: 'activity-nav', class: 'conversation-item' }), el('button', { id: 'overview-chat-button', class: 'primary-button compact-button' }), el('div', { class: 'sidebar' }));
  return doc;
}

function setMessageValue(text: string) {
  const input = document.querySelector('#message-input') as HTMLElement;
  input.value = text;
}

function userMessageCount(): number {
  const list = document.querySelector('#message-list') as HTMLElement;
  return list.querySelectorAll('.message.user').length;
}

function assistantMessageCount(): number {
  const list = document.querySelector('#message-list') as HTMLElement;
  return list.querySelectorAll('.message.assistant').length;
}

function errorMessageCount(): number {
  const list = document.querySelector('#message-list') as HTMLElement;
  return list.querySelectorAll('.message-error').length;
}

function composerDisabled(): boolean {
  const btn = document.querySelector('#send-button') as HTMLElement;
  const input = document.querySelector('#message-input') as HTMLElement;
  return btn.disabled === true && input.disabled === true;
}

function pendingVisible(): boolean {
  const typing = document.querySelector('#typing-state') as HTMLElement;
  return !typing.classList.contains('hidden');
}

function ariaBusy(): boolean {
  const form = document.querySelector('#message-form') as HTMLElement;
  return form.getAttribute('aria-busy') === 'true';
}

function submitForm() {
  const form = document.querySelector('#message-form') as HTMLElement;
  form.requestSubmit();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ─── Load the real client code once the shim and default fetch are in place ─

beforeAll(async () => {
  globalThis.document = buildDocument() as unknown as Document;
  setFetchResponse({ ok: false, status: 401, json: async () => ({ error: 'INVALID_SESSION' }) });
  await import('../../web/app.js');
});

beforeEach(() => {
  const list = document.querySelector('#message-list') as HTMLElement;
  list.replaceChildren();
  const typing = document.querySelector('#typing-state') as HTMLElement;
  typing.classList.add('hidden');
  const form = document.querySelector('#message-form') as HTMLElement;
  form.removeAttribute('aria-busy');
  const btn = document.querySelector('#send-button') as HTMLElement;
  const input = document.querySelector('#message-input') as HTMLElement;
  btn.disabled = false;
  input.disabled = false;
  input.value = '';
  deferredResolve = null;
  deferredPromise = null;
});

afterEach(() => {
  deferredResolve = null;
  deferredPromise = null;
  vi.restoreAllMocks();
});

describe('CST web chat — pending feedback (rendered behavior)', () => {
  it('1. renders the user message immediately, before the API call resolves', async () => {
    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('What is the status of my farm?');
    submitForm();

    // User message must already be in the list while the request is unresolved.
    expect(userMessageCount()).toBe(1);
    const list = document.querySelector('#message-list') as HTMLElement;
    expect(list.querySelector('.message.user')?.textContent).toContain('What is the status of my farm?');

    resolveDeferredMessageFetch({ ok: true, status: 200, json: async () => ({ reply_text: 'Farm status is normal.' }) });
    await tick();
    expect(assistantMessageCount()).toBe(1);
  });

  it('2. shows the pending indicator while the request is unresolved', async () => {
    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('Check Zone 1 moisture');
    submitForm();

    expect(pendingVisible()).toBe(true);
    expect(ariaBusy()).toBe(true);

    resolveDeferredMessageFetch({ ok: true, status: 200, json: async () => ({ reply_text: 'Zone 1 moisture is 68%' }) });
    await tick();
    expect(pendingVisible()).toBe(false);
    expect(ariaBusy()).toBe(false);
  });

  it('3. disables the composer while pending', async () => {
    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('status');
    submitForm();

    expect(composerDisabled()).toBe(true);

    resolveDeferredMessageFetch({ ok: true, status: 200, json: async () => ({ reply_text: 'ok' }) });
    await tick();
    expect(composerDisabled()).toBe(false);
  });

  it('4. prevents duplicate submissions while pending', async () => {
    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('What is the status of my farm?');
    submitForm();
    expect(userMessageCount()).toBe(1);

    // Second submission while the first is still unresolved must be ignored.
    setMessageValue('second');
    submitForm();
    expect(userMessageCount()).toBe(1);

    resolveDeferredMessageFetch({ ok: true, status: 200, json: async () => ({ reply_text: 'ack' }) });
    await tick();
    expect(userMessageCount()).toBe(1);
  });

  it('5. removes pending state and renders the assistant reply on success', async () => {
    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('How do I clean the filter?');
    submitForm();
    expect(pendingVisible()).toBe(true);

    resolveDeferredMessageFetch({ ok: true, status: 200, json: async () => ({ reply_text: 'Rinse the filter under cold water.' }) });
    await tick();

    expect(pendingVisible()).toBe(false);
    expect(ariaBusy()).toBe(false);
    expect(composerDisabled()).toBe(false);
    expect(assistantMessageCount()).toBe(1);
    const list = document.querySelector('#message-list') as HTMLElement;
    expect(list.querySelector('.message.assistant')?.textContent).toContain('Rinse the filter under cold water.');
  });

  it('6. displays a clear error on failure and restores the composer', async () => {
    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('Report an issue');
    submitForm();
    expect(pendingVisible()).toBe(true);

    resolveDeferredMessageFetch({ ok: false, status: 502, json: async () => ({ message: 'upstream unavailable' }) });
    await tick();

    expect(pendingVisible()).toBe(false);
    expect(composerDisabled()).toBe(false);
    expect(ariaBusy()).toBe(false);
    expect(errorMessageCount()).toBe(1);
    const list = document.querySelector('#message-list') as HTMLElement;
    expect(list.querySelector('.message-error')?.textContent).toContain('couldn\'t complete that request');
    expect(list.querySelector('.message-error')?.textContent).toContain('upstream unavailable');
  });

  it('7. has accessibility roles and live announcements', async () => {
    const list = document.querySelector('#message-list') as HTMLElement;
    expect(list.getAttribute('role')).toBe('log');
    expect(list.getAttribute('aria-live')).toBe('polite');

    const typing = document.querySelector('#typing-state') as HTMLElement;
    expect(typing.getAttribute('role')).toBe('status');
    expect(typing.getAttribute('aria-live')).toBe('assertive');
    expect(typing.getAttribute('aria-atomic')).toBe('true');

    setFetchResponse('deferred');
    startDeferredMessageFetch();
    setMessageValue('accessibility check');
    submitForm();
    expect(ariaBusy()).toBe(true);

    resolveDeferredMessageFetch({ ok: true, status: 200, json: async () => ({ reply_text: 'done' }) });
    await tick();
    expect(ariaBusy()).toBe(false);
  });
});
