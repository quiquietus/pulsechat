import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, session } from './api.js';
import { Avatar, MessageList } from './Messages.jsx';

const PAGE = 50;

// ---- message cache -------------------------------------------------------
function byTime(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
function messagesReducer(state, action) {
  switch (action.type) {
    case 'history': {
      const { roomId, messages, older } = action;
      const current = state.rooms[roomId] || [];
      const ids = new Set(current.map((m) => m.id));
      const merged = [...messages.filter((m) => !ids.has(m.id)), ...current].sort(byTime);
      return {
        rooms: { ...state.rooms, [roomId]: merged },
        meta: { ...state.meta, [roomId]: { loaded: true, hasMore: older ? messages.length === PAGE : state.meta[roomId]?.hasMore ?? messages.length === PAGE } },
      };
    }
    case 'incoming': {
      const m = action.message;
      const list = state.rooms[m.roomId] || [];
      if (list.some((x) => x.id === m.id)) return state;
      const i = m.clientId ? list.findIndex((x) => x.clientId === m.clientId) : -1;
      const next = i >= 0 ? list.map((x, j) => (j === i ? m : x)) : [...list, m];
      return { ...state, rooms: { ...state.rooms, [m.roomId]: next } };
    }
    case 'pending':
      return { ...state, rooms: { ...state.rooms, [action.message.roomId]: [...(state.rooms[action.message.roomId] || []), action.message] } };
    case 'failed':
      return {
        ...state,
        rooms: {
          ...state.rooms,
          [action.roomId]: (state.rooms[action.roomId] || []).map((x) => (x.clientId === action.clientId ? { ...x, pending: false, failed: action.error } : x)),
        },
      };
    case 'stale': // after a reconnect, history must be refetched
      return { ...state, meta: {} };
    default:
      return state;
  }
}

// ---- app -----------------------------------------------------------------
export default function ChatApp({ user, onLogout }) {
  const [rooms, setRooms] = useState([]);
  const [users, setUsers] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [activeId, setActiveId] = useState(null);
  const [msgs, dispatch] = useReducer(messagesReducer, { rooms: {}, meta: {} });
  const [unread, setUnread] = useState({});
  const [typing, setTyping] = useState({}); // roomId -> { userId: { username, until } }
  const [notifications, setNotifications] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState('');

  const socketRef = useRef(null);
  const activeRef = useRef(null);
  activeRef.current = activeId;

  const usersById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);
  const roomTitle = useCallback(
    (room) => {
      if (!room) return '';
      if (room.type === 'channel') return room.name;
      const other = room.members.find((id) => id !== user.id);
      return usersById[other]?.username || 'Direct message';
    },
    [usersById, user.id],
  );

  const refreshUsers = useCallback(() => api('/api/users').then(({ users }) => setUsers(users)).catch(() => {}), []);

  const pushToast = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { ...toast, id }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  // Initial data
  useEffect(() => {
    Promise.all([api('/api/rooms'), api('/api/notifications'), refreshUsers()])
      .then(([{ rooms }, { notifications }]) => {
        setRooms(rooms);
        setNotifications(notifications);
        setActiveId((id) => id || rooms.find((r) => r.name === 'general')?.id || rooms[0]?.id || null);
      })
      .catch((err) => (err.status === 401 ? onLogout() : setError(err.message)));
  }, [refreshUsers, onLogout]);

  // Socket lifecycle
  useEffect(() => {
    const socket = io({ auth: { token: session.token } });
    socketRef.current = socket;
    let wasConnected = false;

    socket.on('connect', () => {
      setConnected(true);
      if (wasConnected) {
        dispatch({ type: 'stale' });
        api('/api/rooms').then(({ rooms }) => setRooms(rooms)).catch(() => {});
      }
      wasConnected = true;
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      setConnected(false);
      if (err.message === 'unauthorized') onLogout();
    });

    socket.on('presence:list', ({ online }) => setOnline(new Set(online)));
    socket.on('presence', ({ userId, online }) => {
      setOnline((prev) => {
        const next = new Set(prev);
        online ? next.add(userId) : next.delete(userId);
        return next;
      });
      setUsersIfUnknown(userId);
    });

    socket.on('message:new', (message) => {
      dispatch({ type: 'incoming', message });
      setTyping((t) => clearTyper(t, message.roomId, message.senderId));
      const away = message.roomId !== activeRef.current || document.hidden;
      if (away && message.senderId !== user.id) setUnread((u) => ({ ...u, [message.roomId]: (u[message.roomId] || 0) + 1 }));
    });

    socket.on('typing', ({ roomId, userId, username, isTyping }) => {
      setTyping((t) => (isTyping ? { ...t, [roomId]: { ...t[roomId], [userId]: { username, until: Date.now() + 4000 } } } : clearTyper(t, roomId, userId)));
    });

    socket.on('room:new', (room) => {
      setRooms((rs) => (rs.some((r) => r.id === room.id) ? rs : [...rs, room]));
      if (room.type === 'dm') refreshUsers();
    });

    socket.on('notification', (n) => {
      setNotifications((ns) => [n, ...ns].slice(0, 50));
      const viewing = n.roomId === activeRef.current && !document.hidden;
      if (!viewing) {
        pushToast({ title: n.type === 'dm' ? `Message from ${n.from}` : `${n.from} mentioned you`, body: n.preview, roomId: n.roomId });
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(n.type === 'dm' ? `PulseChat · ${n.from}` : `PulseChat · ${n.from} mentioned you`, { body: n.preview });
        }
      }
    });

    let knownUsers = new Set();
    function setUsersIfUnknown(id) {
      if (!knownUsers.has(id)) {
        knownUsers.add(id);
        refreshUsers();
      }
    }

    return () => socket.disconnect();
  }, [user.id, onLogout, refreshUsers, pushToast]);

  // Expire stale typing indicators
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        let changed = false;
        const next = {};
        for (const [roomId, typers] of Object.entries(prev)) {
          const kept = Object.fromEntries(Object.entries(typers).filter(([, v]) => v.until > now));
          if (Object.keys(kept).length !== Object.keys(typers).length) changed = true;
          if (Object.keys(kept).length) next[roomId] = kept;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Load history for the active room
  useEffect(() => {
    if (!activeId || msgs.meta[activeId]?.loaded) return;
    api(`/api/rooms/${encodeURIComponent(activeId)}/messages?limit=${PAGE}`)
      .then(({ messages }) => dispatch({ type: 'history', roomId: activeId, messages }))
      .catch((err) => setError(err.message));
  }, [activeId, msgs.meta]);

  // Clear unread when the room is in view
  useEffect(() => {
    if (!activeId) return;
    const clear = () => !document.hidden && setUnread((u) => (u[activeId] ? { ...u, [activeId]: 0 } : u));
    clear();
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [activeId, msgs.rooms[activeId]?.length]);

  const openRoom = (roomId) => {
    setActiveId(roomId);
    setSidebarOpen(false);
    const ids = notifications.filter((n) => n.roomId === roomId && !n.read).map((n) => n.id);
    if (ids.length) markRead(ids);
  };

  const markRead = (ids) => {
    setNotifications((ns) => ns.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)));
    api('/api/notifications/read', { body: ids ? { ids } : {} }).catch(() => {});
  };

  const loadOlder = async () => {
    const first = msgs.rooms[activeId]?.find((m) => !m.pending && !m.failed);
    if (!first) return;
    const { messages } = await api(`/api/rooms/${encodeURIComponent(activeId)}/messages?limit=${PAGE}&before=${encodeURIComponent(first.createdAt)}`);
    dispatch({ type: 'history', roomId: activeId, messages, older: true });
  };

  const send = (text) => {
    const roomId = activeId;
    const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    dispatch({
      type: 'pending',
      message: { clientId, roomId, senderId: user.id, senderName: user.username, text, createdAt: new Date().toISOString(), pending: true },
    });
    socketRef.current.timeout(8000).emit('message:send', { roomId, text, clientId }, (err, res) => {
      if (err || res?.error) dispatch({ type: 'failed', roomId, clientId, error: res?.error || 'Not delivered' });
    });
  };

  const emitTyping = (isTyping) => activeId && socketRef.current?.emit('typing', { roomId: activeId, isTyping });

  const createChannel = async (name) => {
    const { room } = await api('/api/rooms', { body: { name } });
    setRooms((rs) => (rs.some((r) => r.id === room.id) ? rs : [...rs, room]));
    openRoom(room.id);
  };

  const openDM = async (otherId) => {
    try {
      const { room } = await api('/api/rooms/dm', { body: { userId: otherId } });
      setRooms((rs) => (rs.some((r) => r.id === room.id) ? rs : [...rs, room]));
      openRoom(room.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const active = rooms.find((r) => r.id === activeId);
  const channels = rooms.filter((r) => r.type === 'channel').sort((a, b) => a.name.localeCompare(b.name));
  const dms = rooms.filter((r) => r.type === 'dm');
  const dmPartner = (room) => room.members.find((id) => id !== user.id);
  const others = users.filter((u) => u.id !== user.id).sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.username.localeCompare(b.username));
  const typers = Object.values(typing[activeId] || {}).map((t) => t.username);
  const unreadNotifs = notifications.filter((n) => !n.read).length;

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand"><span className="logo-mark" /><span>PulseChat</span></div>
        </div>

        <nav className="sidebar-scroll">
          <Section title="Channels" action={<NewChannel onCreate={createChannel} />}>
            {channels.map((r) => (
              <RoomButton key={r.id} active={r.id === activeId} unread={unread[r.id]} onClick={() => openRoom(r.id)}>
                <span className="hash">#</span>{r.name}
              </RoomButton>
            ))}
          </Section>

          {dms.length > 0 && (
            <Section title="Direct messages">
              {dms.map((r) => (
                <RoomButton key={r.id} active={r.id === activeId} unread={unread[r.id]} onClick={() => openRoom(r.id)}>
                  <span className={`dot ${online.has(dmPartner(r)) ? 'on' : ''}`} />
                  {roomTitle(r)}
                </RoomButton>
              ))}
            </Section>
          )}

          <Section title={`People · ${others.filter((u) => online.has(u.id)).length} online`}>
            {others.length === 0 && <p className="empty-hint">No one else yet. Open this page in another browser and sign up as a second user.</p>}
            {others.map((u) => (
              <button key={u.id} className="room person" onClick={() => openDM(u.id)} title={`Message ${u.username}`}>
                <Avatar name={u.username} size={22} online={online.has(u.id)} />
                <span className="truncate">{u.username}</span>
              </button>
            ))}
          </Section>
        </nav>

        <div className="me">
          <Avatar name={user.username} size={30} online={connected} />
          <div className="me-text">
            <strong className="truncate">{user.username}</strong>
            <span className="muted small">{connected ? 'Online' : 'Connecting…'}</span>
          </div>
          <button className="icon-btn" onClick={onLogout} title="Sign out" aria-label="Sign out">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setSidebarOpen(false)} />

      <main className="chat">
        <header className="chat-head">
          <button className="icon-btn menu" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <div className="chat-title">
            {active?.type === 'channel' && <h2><span className="hash">#</span>{active.name}</h2>}
            {active?.type === 'dm' && (
              <h2>
                <span className={`dot ${online.has(dmPartner(active)) ? 'on' : ''}`} />
                {roomTitle(active)}
                <span className="muted small status-text">{online.has(dmPartner(active)) ? 'online' : 'offline'}</span>
              </h2>
            )}
          </div>
          <Bell notifications={notifications} unread={unreadNotifs} onOpen={(n) => openRoom(n.roomId)} onReadAll={() => markRead(null)} />
        </header>

        {!connected && <div className="banner">Reconnecting to the server…</div>}
        {error && <div className="banner error" onClick={() => setError('')}>{error} <span className="small">(dismiss)</span></div>}

        {active ? (
          <>
            <MessageList
              key={active.id}
              messages={msgs.rooms[active.id] || []}
              loaded={Boolean(msgs.meta[active.id]?.loaded)}
              hasMore={Boolean(msgs.meta[active.id]?.hasMore)}
              onLoadOlder={loadOlder}
              me={user}
              intro={active.type === 'channel' ? `This is the start of #${active.name}.` : `This is the start of your conversation with ${roomTitle(active)}.`}
            />
            <div className="typing" aria-live="polite">{typers.length > 0 && <><span className="typing-dots"><i /><i /><i /></span>{formatTypers(typers)}</>}</div>
            <Composer
              key={`c-${active.id}`}
              placeholder={active.type === 'channel' ? `Message #${active.name}` : `Message ${roomTitle(active)}`}
              onSend={send}
              onTyping={emitTyping}
              disabled={!connected}
            />
          </>
        ) : (
          <div className="empty">Loading…</div>
        )}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <button key={t.id} className="toast" onClick={() => { openRoom(t.roomId); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
            <strong>{t.title}</strong>
            <span>{t.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function clearTyper(t, roomId, userId) {
  if (!t[roomId]?.[userId]) return t;
  const { [userId]: _, ...rest } = t[roomId];
  return { ...t, [roomId]: rest };
}

function formatTypers(names) {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

function Section({ title, action, children }) {
  return (
    <section className="section">
      <div className="section-head"><span>{title}</span>{action}</div>
      {children}
    </section>
  );
}

function RoomButton({ active, unread, onClick, children }) {
  return (
    <button className={`room ${active ? 'active' : ''} ${unread ? 'has-unread' : ''}`} onClick={onClick}>
      <span className="room-label truncate">{children}</span>
      {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

function NewChannel({ onCreate }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  if (!open) {
    return (
      <button className="icon-btn tiny" onClick={() => setOpen(true)} title="New channel" aria-label="New channel">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    );
  }
  const submit = async (e) => {
    e.preventDefault();
    try {
      await onCreate(name);
      setOpen(false);
      setName('');
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <form className="new-channel" onSubmit={submit}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="channel-name" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      {error && <span className="error small">{error}</span>}
    </form>
  );
}

function Bell({ notifications, unread, onOpen, onReadAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = () => {
    setOpen((o) => !o);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  };

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn" onClick={toggle} aria-label={`Notifications (${unread} unread)`}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread > 0 && <span className="badge floating">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="dropdown-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link small" onClick={onReadAll}>Mark all read</button>}
          </div>
          {notifications.length === 0 && <p className="empty-hint">Direct messages and @mentions show up here.</p>}
          {notifications.map((n) => (
            <button key={n.id} className={`notif ${n.read ? '' : 'unread'}`} onClick={() => { onOpen(n); setOpen(false); }}>
              <Avatar name={n.from} size={28} />
              <span className="notif-body">
                <span><strong>{n.from}</strong> {n.type === 'dm' ? 'sent you a message' : 'mentioned you'}</span>
                <span className="muted small truncate">{n.preview}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ placeholder, onSend, onTyping, disabled }) {
  const [text, setText] = useState('');
  const typingRef = useRef({ active: false, last: 0, timer: null });

  const stopTyping = () => {
    const t = typingRef.current;
    clearTimeout(t.timer);
    if (t.active) {
      t.active = false;
      onTyping(false);
    }
  };
  useEffect(() => stopTyping, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (e) => {
    setText(e.target.value);
    const t = typingRef.current;
    const now = Date.now();
    if (!t.active || now - t.last > 2000) {
      t.active = true;
      t.last = now;
      onTyping(true);
    }
    clearTimeout(t.timer);
    t.timer = setTimeout(stopTyping, 2500);
  };

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText('');
    stopTyping();
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        rows={1}
        value={text}
        onChange={onChange}
        onBlur={stopTyping}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        maxLength={2000}
        aria-label={placeholder}
      />
      <button className="send" disabled={!text.trim() || disabled} aria-label="Send">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>
      </button>
    </form>
  );
}
