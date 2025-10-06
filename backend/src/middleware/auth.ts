import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../models/User';

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

    if (!token) {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
      return;
    }

    // Verificar JWT
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      githubId: string;
    };

    // Buscar usuario
    const user = await User.findById(decoded.userId);

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User not found',
      });
      return;
    }

    // Agregar usuario al request
    req.user = {
      id: (user._id as any).toString(),
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

    console.error('Authentication error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed',
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
