import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, session } from './api.js';
import AuthScreen from './AuthScreen.jsx';
import ChatApp from './ChatApp.jsx';
import './styles.css';

function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(session.token));

  useEffect(() => {
    if (!session.token) return;
    api('/api/auth/me')
      .then(({ user }) => setUser(user))
      .catch(() => (session.token = null))
      .finally(() => setChecking(false));
  }, []);

  const onAuth = ({ token, user }) => {
    session.token = token;
    setUser(user);
  };
  const logout = () => {
    session.token = null;
    setUser(null);
  };

  if (checking) return <div className="splash"><div className="logo-mark big" /></div>;
  return user ? <ChatApp user={user} onLogout={logout} /> : <AuthScreen onAuth={onAuth} />;
}

createRoot(document.getElementById('root')).render(<App />);
