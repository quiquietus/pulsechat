// Auth service: registration, login and identity. Issues JWTs that every other
// service verifies locally.
import express from 'express';
import bcrypt from 'bcryptjs';
import { signToken, requireAuth, asyncRoute } from '../../shared/auth.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function createAuthService({ store }) {
  const router = express.Router();

  router.post('/register', asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const user = await store.users.create({ username, passwordHash: await bcrypt.hash(password, 10) });
    if (!user) return res.status(409).json({ error: 'Username is already taken' });
    res.status(201).json({ token: signToken(user), user });
  }));

  router.post('/login', asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const found = await store.users.findByUsername(username);
    if (!found || !(await bcrypt.compare(password, found.passwordHash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const { passwordHash, ...user } = found;
    res.json({ token: signToken(user), user });
  }));

  router.get('/me', requireAuth, asyncRoute(async (req, res) => {
    const user = await store.users.findById(req.user.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    res.json({ user });
  }));

  return { name: 'auth', mount: '/api/auth', router };
}
