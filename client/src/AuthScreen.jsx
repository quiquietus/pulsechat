import React, { useState } from 'react';
import { api } from './api.js';

export default function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onAuth(await api(`/api/auth/${mode}`, { body: { username: username.trim(), password } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const isLogin = mode === 'login';
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="logo-mark" />
          <span>PulseChat</span>
        </div>
        <h1>{isLogin ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">Real-time channels, direct messages, presence and notifications.</p>

        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="e.g. ada_l"
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            placeholder={isLogin ? '' : 'At least 6 characters'}
            required
          />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
        </button>
        <p className="switch">
          {isLogin ? 'New here?' : 'Already have an account?'}{' '}
          <button type="button" className="link" onClick={() => { setMode(isLogin ? 'register' : 'login'); setError(''); }}>
            {isLogin ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  );
}
