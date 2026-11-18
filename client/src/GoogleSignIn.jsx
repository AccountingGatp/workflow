import { useEffect, useRef, useState } from 'react';
import { api, useAuth } from './lib.jsx';
import { ErrorBox } from './ui.jsx';

let googleScript;
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  googleScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve(window.google.accounts.id);
    script.onerror = () => { googleScript = undefined; script.remove(); reject(new Error('Could not load Google sign-in')); };
    document.head.append(script);
  });
  return googleScript;
}

export default function GoogleSignIn({ clientId }) {
  const button = useRef(null);
  const { loginGoogle } = useAuth();
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const container = button.current;
    async function render() {
      const google = await loadGoogle();
      if (!active) return;
      const { nonce } = await api('/auth/google/nonce');
      if (!active) return;
      google.initialize({ client_id: clientId, nonce, callback: async ({ credential }) => {
        try {
          await loginGoogle(credential);
        } catch (error) {
          if (active) setError(error);
        }
      } });
      google.renderButton(container, { theme: 'outline', size: 'large', width: 260 });
    }
    render().catch((error) => { if (active) setError(error); });
    return () => { active = false; container.replaceChildren(); };
  }, [clientId, loginGoogle]);
  return <div className="stack"><div ref={button} /><ErrorBox error={error} /></div>;
}
