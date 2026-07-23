import { AuthForm } from '../auth/auth-form';

interface RegisterPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const value = (await searchParams).returnTo;
  return <AuthForm mode="register" {...(typeof value === 'string' ? { returnTo: value } : {})} />;
}
