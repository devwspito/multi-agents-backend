import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UserRepository } from '../database/repositories/UserRepository.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    githubId: string;
    username: string;
    email: string;
  };
}

/**
 * Middleware para autenticar requests usando JWT
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);

    console.log('[Auth] Token extraction:', token ? `Token found (${token.substring(0, 20)}...)` : 'No token');

    if (!token) {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
      return;
    }

    // Verificar JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as {
        userId: string;
        githubId: string;
      };
      console.log('[Auth] Token decoded successfully:', decoded);
    } catch (jwtError: any) {
      console.error('[Auth] JWT verification failed:', jwtError.message);
      throw jwtError;
    }

    // Buscar usuario (SQLite - synchronous)
    console.log('[Auth] Looking for user with ID:', decoded.userId);
    const user = UserRepository.findById(decoded.userId);

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    // Agregar usuario al request
    req.user = {
      id: user.id,
      githubId: user.githubId,
      username: user.username,
      email: user.email,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
      return;
    }

    console.error('[Auth] Authentication error - Full details:', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      token: extractToken(req)?.substring(0, 20) + '...'
    });
    res.status(500).json({
      success: false,
      message: 'Authentication failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * Extrae el token JWT del request
 */
function extractToken(req: Request): string | null {
  // Desde header Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Desde cookie
  if (req.cookies?.token) {
    return req.cookies.token;
  }

  return null;
}

/**
 * Genera un JWT token para un usuario
 */
export function generateToken(userId: string, githubId: string): string {
  return jwt.sign(
    {
      userId,
      githubId,
    },
    env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  );
}
