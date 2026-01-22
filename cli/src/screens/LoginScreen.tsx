/**
 * Login Screen
 * Handles user authentication
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { api } from '../api/client.js';
import { configStore } from '../utils/config.js';

type LoginStep = 'choice' | 'email' | 'password' | 'name' | 'loading' | 'success' | 'error';

interface LoginScreenProps {
  onLoginSuccess: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [step, setStep] = useState<LoginStep>('choice');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (step === 'choice') {
      if (input === '1') {
        setMode('login');
        setStep('email');
      } else if (input === '2') {
        setMode('register');
        setStep('email');
      }
    }
  });

  const handleEmailSubmit = () => {
    if (!email.includes('@')) {
      setError('Please enter a valid email');
      return;
    }
    setError(null);
    if (mode === 'register') {
      setStep('name');
    } else {
      setStep('password');
    }
  };

  const handleNameSubmit = () => {
    if (name.length < 2) {
      setError('Name must be at least 2 characters');
      return;
    }
    setError(null);
    setStep('password');
  };

  const handlePasswordSubmit = async () => {
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setError(null);
    setStep('loading');

    try {
      let response;
      if (mode === 'register') {
        response = await api.register(name, email, password);
      } else {
        response = await api.login(email, password);
      }

      if (response.success) {
        const { token, user } = response.data;

        configStore.login({
          token,
          userId: user._id || user.id,
          userName: user.name,
          userEmail: user.email,
          githubConnected: !!user.githubId,
        });

        setStep('success');
        setTimeout(onLoginSuccess, 1500);
      } else {
        setError(response.message || 'Authentication failed');
        setStep('error');
      }
    } catch (err: any) {
      const message = err.response?.data?.message || err.message || 'Connection failed';
      setError(message);
      setStep('error');
    }
  };

  const handleRetry = () => {
    setStep('choice');
    setEmail('');
    setPassword('');
    setName('');
    setError(null);
  };

  return (
    <Box flexDirection="column" padding={2}>
      <Box marginBottom={2}>
        <Text bold color="cyan">
          ═══════════════════════════════════════════
        </Text>
      </Box>
      <Box marginBottom={2} justifyContent="center">
        <Text bold color="cyan">
          🤖 AI Development Team - Login
        </Text>
      </Box>
      <Box marginBottom={2}>
        <Text bold color="cyan">
          ═══════════════════════════════════════════
        </Text>
      </Box>

      {step === 'choice' && (
        <Box flexDirection="column" gap={1}>
          <Text>Welcome! Please choose an option:</Text>
          <Text> </Text>
          <Text color="yellow">[1] Login with existing account</Text>
          <Text color="yellow">[2] Create new account</Text>
        </Box>
      )}

      {step === 'email' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            {mode === 'register' ? 'Create Account' : 'Login'} - Enter your email:
          </Text>
          <Box>
            <Text color="cyan">Email: </Text>
            <TextInput
              value={email}
              onChange={setEmail}
              onSubmit={handleEmailSubmit}
              placeholder="you@example.com"
            />
          </Box>
          {error && <Text color="red">⚠ {error}</Text>}
        </Box>
      )}

      {step === 'name' && (
        <Box flexDirection="column" gap={1}>
          <Text>Create Account - Enter your name:</Text>
          <Box>
            <Text color="cyan">Name: </Text>
            <TextInput
              value={name}
              onChange={setName}
              onSubmit={handleNameSubmit}
              placeholder="Your Name"
            />
          </Box>
          {error && <Text color="red">⚠ {error}</Text>}
        </Box>
      )}

      {step === 'password' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            {mode === 'register' ? 'Create Account' : 'Login'} - Enter your password:
          </Text>
          <Box>
            <Text color="cyan">Password: </Text>
            <TextInput
              value={password}
              onChange={setPassword}
              onSubmit={handlePasswordSubmit}
              mask="*"
              placeholder="••••••••"
            />
          </Box>
          {error && <Text color="red">⚠ {error}</Text>}
        </Box>
      )}

      {step === 'loading' && (
        <Box gap={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text>
            {mode === 'register' ? 'Creating account...' : 'Logging in...'}
          </Text>
        </Box>
      )}

      {step === 'success' && (
        <Box flexDirection="column" gap={1}>
          <Text color="green">✓ {mode === 'register' ? 'Account created!' : 'Login successful!'}</Text>
          <Text color="gray">Redirecting to dashboard...</Text>
        </Box>
      )}

      {step === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color="red">✗ {error}</Text>
          <Text> </Text>
          <Text color="yellow">Press any key to try again...</Text>
          <Box>
            <TextInput value="" onChange={handleRetry} onSubmit={handleRetry} />
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default LoginScreen;
