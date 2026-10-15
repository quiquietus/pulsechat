import React, { useLayoutEffect, useRef, useState } from 'react';

const HUES = [262, 200, 160, 24, 330, 45, 290, 180];
function hueFor(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function Avatar({ name, size = 32, online }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, '--hue': hueFor(name) }}>
      {(name || '?').slice(0, 1).toUpperCase()}
      {online !== undefined && <span className={`avatar-dot ${online ? 'on' : ''}`} />}
    </span>
  );
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}

function renderText(text, me) {
  return text.split(/(@[a-zA-Z0-9_]{3,20})/g).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className={`mention ${part.slice(1).toLowerCase() === me.username.toLowerCase() ? 'mention-self' : ''}`}>{part}</span>
    ) : (
      part
    ),
  );
}

export function MessageList({ messages, loaded, hasMore, onLoadOlder, me, intro }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current; // keep position when prepending
      loadingOlder.current = false;
      return;
    }
    const last = messages[messages.length - 1];
    if (stick.current || last?.senderId === me.id) el.scrollTop = el.scrollHeight;
  }, [messages, me.id]);

  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const older = async () => {
    setBusy(true);
    prevHeight.current = ref.current.scrollHeight;
    loadingOlder.current = true;
    try {
      await onLoadOlder();
    } catch {
      loadingOlder.current = false;
    } finally {
      setBusy(false);
    }
  };

  const items = [];
  let prev = null;
  for (const m of messages) {
    const day = dayLabel(m.createdAt);
    if (!prev || dayLabel(prev.createdAt) !== day) items.push(<div key={`d-${m.createdAt}-${m.id || m.clientId}`} className="day"><span>{day}</span></div>);
    const grouped = prev && prev.senderId === m.senderId && dayLabel(prev.createdAt) === day && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60e3;
    const mine = m.senderId === me.id;
    items.push(
      <div key={m.id || m.clientId} className={`msg ${grouped ? 'grouped' : ''} ${mine ? 'mine' : ''} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''}`}>
        <div className="msg-gutter">
          {grouped ? <span className="hover-time">{timeFmt.format(new Date(m.createdAt))}</span> : <Avatar name={m.senderName} size={36} />}
        </div>
        <div className="msg-main">
          {!grouped && (
            <div className="msg-meta">
              <strong>{m.senderName}</strong>
              <time dateTime={m.createdAt}>{timeFmt.format(new Date(m.createdAt))}</time>
            </div>
          )}
          <div className="msg-text">{renderText(m.text, me)}</div>
          {m.failed && <div className="error small">Not sent: {m.failed}</div>}
        </div>
      </div>,
    );
    prev = m;
  }

  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      <div className="messages-inner">
        {loaded && hasMore && (
          <button className="load-older" onClick={older} disabled={busy}>{busy ? 'Loading…' : 'Load earlier messages'}</button>
        )}
        {loaded && !hasMore && <div className="intro">{intro}</div>}
        {!loaded && <div className="intro muted">Loading messages…</div>}
        {items}
      </div>
    </div>
  );
}
