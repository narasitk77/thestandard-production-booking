import { redirect } from 'next/navigation'
import LoginForm from './LoginForm'

export default function LoginPage() {
  // When auth is disabled there's no login step — bounce straight to the app.
  if (process.env.AUTH_DISABLED === '1') redirect('/')
  return <LoginForm />
}
