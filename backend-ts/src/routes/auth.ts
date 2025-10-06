import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { User } from '../models/User';
import { generateToken } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

// Store OAuth states temporarily (en producción usar Redis)
const oauthStates = new Map<string, { createdAt: number }>();

// Limpiar estados expirados cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of oauthStates.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      // 10 minutos
      oauthStates.delete(state);
    }
  }
}, 5 * 60 * 1000);

/**
 * GET /api/auth/github
 * Inicia el flujo de autenticación con GitHub
 */
router.get('/github', (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/github/callback`,
    scope: 'user:email',
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

/**
 * GET /api/auth/github/callback
 * Callback de GitHub OAuth
 */
router.get('/github/callback', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;

    // Validar state
    if (!state || !oauthStates.has(state as string)) {
      res.redirect(`${env.FRONTEND_URL}?error=invalid_state`);
      return;
    }

    oauthStates.delete(state as string);

    if (!code) {
      res.redirect(`${env.FRONTEND_URL}?error=no_code`);
      return;
    }

    // Intercambiar code por access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData: any = await tokenResponse.json();

    if (!tokenData.access_token) {
      console.error('GitHub OAuth error:', tokenData);
      res.redirect(`${env.FRONTEND_URL}?error=token_exchange_failed`);
      return;
    }

    // Obtener información del usuario
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    const githubUser: any = await userResponse.json();

    // Obtener email si no está público
    let email = githubUser.email;
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/json',
        },
      });
      const emails: any = await emailsResponse.json();
      const primaryEmail = emails.find((e: any) => e.primary);
      email = primaryEmail?.email || emails[0]?.email;
    }

    // Crear o actualizar usuario
    let user = await User.findOne({ githubId: githubUser.id.toString() });

    if (user) {
      // Actualizar usuario existente
      user.username = githubUser.login;
      user.email = email;
      user.avatarUrl = githubUser.avatar_url;
      user.accessToken = tokenData.access_token;
      user.refreshToken = tokenData.refresh_token;
      await user.save();
    } else {
      // Crear nuevo usuario
      user = await User.create({
        githubId: githubUser.id.toString(),
        username: githubUser.login,
        email,
        avatarUrl: githubUser.avatar_url,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
      });
    }

    // Generar JWT
    const token = generateToken((user._id as any).toString(), user.githubId);

    // Redirigir al frontend con el token
    res.redirect(`${env.FRONTEND_URL}/auth/callback?token=${token}`);
  } catch (error) {
    console.error('GitHub OAuth callback error:', error);
    res.redirect(`${env.FRONTEND_URL}?error=auth_failed`);
  }
});

/**
 * GET /api/auth/me
 * Obtener información del usuario autenticado
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
      return;
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: string };

    const user = await User.findById(decoded.userId).select('-accessToken -refreshToken -__v');

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        id: user._id,
        githubId: user.githubId,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }
});

/**
 * POST /api/auth/logout
 * Cerrar sesión (opcional, JWT es stateless)
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

export default router;
