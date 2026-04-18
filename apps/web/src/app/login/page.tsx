'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowRight, CheckCircle } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';

type AuthMode = 'login' | 'signup' | 'forgot' | 'reset-sent';

const FIREBASE_ERROR_MESSAGES: Record<string, string> = {
  'auth/user-not-found': 'No account found with this email address.',
  'auth/wrong-password': 'Incorrect password. Please try again.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Password must be at least 8 characters long.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
  'auth/invalid-credential': 'Invalid email or password.',
};

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, signIn, signUp, signInWithGoogle, resetPassword } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [resetEmail, setResetEmail] = useState('');

  // Redirect if already logged in
  useEffect(() => {
    if (user && !loading) {
      router.push('/dashboard');
    }
  }, [user, loading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (mode === 'login') {
        await signIn(email, password);
        router.push('/dashboard');
      } else if (mode === 'signup') {
        // Validate inputs
        if (!name.trim()) {
          setError('Please enter your full name.');
          setIsLoading(false);
          return;
        }
        if (!company.trim()) {
          setError('Please enter your company name.');
          setIsLoading(false);
          return;
        }
        if (password.length < 8) {
          setError('Password must be at least 8 characters long.');
          setIsLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setError('Passwords do not match.');
          setIsLoading(false);
          return;
        }

        await signUp(email, password, name, company);
        router.push('/dashboard');
      }
    } catch (err: any) {
      const errorCode = err?.code || '';
      const friendlyMessage = FIREBASE_ERROR_MESSAGES[errorCode] || err?.message || 'An error occurred. Please try again.';
      setError(friendlyMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setIsLoading(true);

    try {
      await signInWithGoogle();
      router.push('/dashboard');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to sign in with Google';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await resetPassword(resetEmail);
      setMode('reset-sent');
      setResetEmail('');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send reset email';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="animate-spin">
          <Activity className="w-8 h-8 text-indigo-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Left Panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-black text-white flex-col justify-between p-12">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-indigo-500 rounded-lg p-2">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold">growth</h1>
          </div>
          <p className="text-indigo-400 text-sm">AI Revenue System</p>
        </div>
        <div>
          <p className="text-xl font-semibold mb-2">Your AI-powered revenue engine that learns, decides, and acts.</p>
          <p className="text-gray-400 text-sm">Transform your revenue operations with intelligent automation and real-time insights.</p>
        </div>
        <div className="text-gray-500 text-xs">© 2026 growth. All rights reserved.</div>
      </div>

      {/* Right Panel - Form */}
      <div className="w-full lg:w-1/2 bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Logo for mobile */}
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <div className="bg-indigo-500 rounded-lg p-2">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold text-black">growth</h1>
          </div>

          {/* Reset sent success state */}
          {mode === 'reset-sent' && (
            <div className="text-center">
              <div className="flex justify-center mb-4">
                <CheckCircle className="w-12 h-12 text-green-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Check your email</h2>
              <p className="text-gray-600 mb-6">We've sent a password reset link to your email address.</p>
              <button
                onClick={() => {
                  setMode('login');
                  setEmail('');
                }}
                className="text-indigo-600 hover:text-indigo-700 font-medium"
              >
                Back to login
              </button>
            </div>
          )}

          {/* Forgot password form */}
          {mode === 'forgot' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Reset your password</h2>
              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-800 text-sm">{error}</p>
                </div>
              )}
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <label htmlFor="reset-email" className="block text-sm font-medium text-gray-700 mb-2">
                    Email address
                  </label>
                  <input
                    id="reset-email"
                    type="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    placeholder="you@example.com"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium py-2 rounded-lg transition-colors"
                >
                  {isLoading ? '...' : 'Send reset link'}
                </button>
              </form>
              <button
                onClick={() => {
                  setMode('login');
                  setError('');
                  setResetEmail('');
                }}
                className="w-full mt-4 text-indigo-600 hover:text-indigo-700 font-medium"
              >
                Back to login
              </button>
            </div>
          )}

          {/* Login & Signup Forms */}
          {mode !== 'forgot' && mode !== 'reset-sent' && (
            <div>
              {/* Tabs */}
              <div className="flex gap-4 mb-8 border-b border-gray-200">
                <button
                  onClick={() => {
                    setMode('login');
                    setError('');
                    setEmail('');
                    setPassword('');
                    setConfirmPassword('');
                  }}
                  className={`pb-3 font-medium transition-colors ${
                    mode === 'login'
                      ? 'text-indigo-600 border-b-2 border-indigo-600'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Sign in
                </button>
                <button
                  onClick={() => {
                    setMode('signup');
                    setError('');
                    setEmail('');
                    setPassword('');
                    setConfirmPassword('');
                    setName('');
                    setCompany('');
                  }}
                  className={`pb-3 font-medium transition-colors ${
                    mode === 'signup'
                      ? 'text-indigo-600 border-b-2 border-indigo-600'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Sign up
                </button>
              </div>

              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-800 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Signup-only fields */}
                {mode === 'signup' && (
                  <>
                    <div>
                      <label htmlFor="company" className="block text-sm font-medium text-gray-700 mb-2">
                        Company name
                      </label>
                      <input
                        id="company"
                        type="text"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                        placeholder="Acme Inc."
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-2">
                        Full name
                      </label>
                      <input
                        id="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                        placeholder="John Doe"
                        required
                      />
                    </div>
                  </>
                )}

                {/* Email field */}
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    placeholder="you@example.com"
                    required
                  />
                </div>

                {/* Password field */}
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    placeholder="••••••••"
                    required
                  />
                  {mode === 'signup' && (
                    <p className="text-xs text-gray-500 mt-1">At least 8 characters</p>
                  )}
                </div>

                {/* Confirm password - signup only */}
                {mode === 'signup' && (
                  <div>
                    <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-2">
                      Confirm password
                    </label>
                    <input
                      id="confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                      placeholder="••••••••"
                      required
                    />
                  </div>
                )}

                {/* Forgot password link - login only */}
                {mode === 'login' && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setMode('forgot')}
                      className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                    >
                      Forgot password?
                    </button>
                  </div>
                )}

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {isLoading ? '...' : mode === 'login' ? 'Sign in' : 'Create account'}
                  {!isLoading && <ArrowRight className="w-4 h-4" />}
                </button>
              </form>

              {/* Divider */}
              <div className="my-6 flex items-center gap-4">
                <div className="flex-1 h-px bg-gray-200"></div>
                <span className="text-xs text-gray-500">OR</span>
                <div className="flex-1 h-px bg-gray-200"></div>
              </div>

              {/* Google Sign In Button */}
              <button
                onClick={handleGoogleSignIn}
                disabled={isLoading}
                className="w-full border border-gray-300 hover:border-gray-400 text-gray-700 font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                Continue with Google
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
