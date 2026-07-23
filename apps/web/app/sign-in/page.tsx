import { AuthForm } from '../auth/auth-form';

interface SignInPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const value = (await searchParams).returnTo;
  return <AuthForm mode="login" {...(typeof value === 'string' ? { returnTo: value } : {})} />;
}
