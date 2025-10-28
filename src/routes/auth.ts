import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { User } from '../models/User';
import { OAuthState } from '../models/OAuthState';
import { generateToken } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

/**
 * GET /api/auth/github-auth/url
 * Devuelve la URL de autorización de GitHub (para frontends SPA)
 */
router.get('/github-auth/url', async (req: Request, res: Response) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');

    // Guardar estado en MongoDB (TTL automático de 10 minutos)
    const savedState = await OAuthState.create({ state });
    console.log(`✅ OAuth state created and saved: ${state}`, { id: savedState._id });

    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/github/callback`,
      scope: 'user:email repo',
      state,
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

    res.json({
      success: true,
      url: authUrl,
    });
  } catch (error) {
    console.error('❌ Error generating GitHub auth URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate auth URL',
    });
  }
});

/**
 * GET /api/auth/github
 * Inicia el flujo de autenticación con GitHub (redirección directa)
 */
router.get('/github', async (req: Request, res: Response) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');

    // Guardar estado en MongoDB (TTL automático de 10 minutos)
    const savedState = await OAuthState.create({ state });
    console.log(`✅ OAuth state created and saved (direct): ${state}`, { id: savedState._id });

    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/github/callback`,
      scope: 'user:email repo',
      state,
    });

    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  } catch (error) {
    console.error('❌ Error initiating GitHub auth:', error);
    res.redirect(`${env.FRONTEND_URL}?error=auth_init_failed`);
  }
});

/**
 * GET /api/auth/github/callback
 * Callback de GitHub OAuth
 */
router.get('/github/callback', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;

    console.log(`🔍 OAuth callback received - state: ${state}, code: ${code ? 'present' : 'missing'}`);

    // Validar state desde MongoDB
    if (!state) {
      console.error('❌ OAuth callback: missing state parameter');
      res.redirect(`${env.FRONTEND_URL}?error=invalid_state`);
      return;
    }

    // Verificar cuántos estados hay en la DB para debug
    const allStates = await OAuthState.find({});
    console.log(`📊 Total OAuth states in DB: ${allStates.length}`, allStates.map(s => s.state));

    const oauthState = await OAuthState.findOne({ state: state as string });

    if (!oauthState) {
      console.error(`❌ OAuth callback: state not found in database: ${state}`);
      console.error(`   Available states: ${allStates.map(s => s.state).join(', ')}`);
      res.redirect(`${env.FRONTEND_URL}?error=invalid_state`);
      return;
    }

    console.log(`✅ OAuth state validated: ${state}`);

    // Eliminar el estado usado (one-time use)
    await OAuthState.deleteOne({ state: state as string });

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
    let user;

    try {
      // Intentar crear nuevo usuario
      user = await User.create({
        githubId: githubUser.id.toString(),
        username: githubUser.login,
        email,
        avatarUrl: githubUser.avatar_url,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
      });
    } catch (error: any) {
      // Si falla por clave duplicada, buscar y actualizar
      if (error.code === 11000) {
        user = await User.findOne({ username: githubUser.login });

        if (user) {
          user.githubId = githubUser.id.toString();
          user.email = email;
          user.avatarUrl = githubUser.avatar_url;
          user.accessToken = tokenData.access_token;
          user.refreshToken = tokenData.refresh_token;
          await user.save();
        } else {
          // No debería pasar, pero por si acaso
          throw error;
        }
      } else {
        throw error;
      }
    }

    // Generar JWT
    const token = generateToken((user._id as any).toString(), user.githubId);

    // Redirigir al frontend con el token y el indicador de GitHub
    res.redirect(`${env.FRONTEND_URL}/auth/callback?token=${token}&github=connected`);
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

    const user = await User.findById(decoded.userId).select('-refreshToken -__v');

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
        hasGithubConnected: !!user.accessToken, // NUEVO: indica si tiene GitHub conectado
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

/**
 * GET /api/auth/me/api-key
 * Get user's default Anthropic API key
 */
router.get('/me/api-key', async (req: any, res): Promise<any> => {
  try {
    const { authenticate } = await import('../middleware/auth');
    return await authenticate(req, res, async () => {
      const user = await User.findById(req.user.id).select('+defaultApiKey');

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
        });
      }

      // Return masked API key for security (show only last 4 chars)
      const apiKey = user.defaultApiKey;
      const maskedKey = apiKey
        ? `sk-ant-...${apiKey.slice(-4)}`
        : null;

      return res.json({
        success: true,
        data: {
          hasApiKey: !!apiKey,
          maskedKey,
        },
      });
    });
  } catch (error: any) {
    console.error('❌ Error getting user API key:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get API key',
    });
  }
});

/**
 * PUT /api/auth/me/api-key
 * Update user's default Anthropic API key
 */
router.put('/me/api-key', async (req: any, res): Promise<any> => {
  try {
    const { authenticate } = await import('../middleware/auth');
    return await authenticate(req, res, async () => {
      const { apiKey } = req.body;

      // Validate API key format
      if (apiKey && !apiKey.startsWith('sk-ant-')) {
        return res.status(400).json({
          success: false,
          message: 'Invalid Anthropic API key format',
        });
      }

      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
        });
      }

      user.defaultApiKey = apiKey || undefined;
      await user.save();

      return res.json({
        success: true,
        message: 'Default API key updated successfully',
        data: {
          hasApiKey: !!apiKey,
        },
      });
    });
  } catch (error: any) {
    console.error('❌ Error updating user API key:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update API key',
    });
  }
});

export default router;
