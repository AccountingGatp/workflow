import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Provider } from 'react-redux';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';
import { AuthProvider, ToastProvider, api, useApi, useAuth } from './lib.jsx';
import { createWorkflowStore } from './daily-work-data.js';
import Layout from './Layout.jsx';
import DailyWork from './pages/daily-work.jsx';
import Settings from './pages/settings.jsx';
import { MyWork, Overview } from './pages/work.jsx';
import { Clients, ClientDetail } from './pages/clients.jsx';
import { ClientProjects } from './pages/projects.jsx';
import { People, Recurring, Access, Audit, Login } from './pages/org.jsx';
import { Skeleton } from './ui.jsx';

const Mail = lazy(() => import('./pages/mail.jsx').then(({ Mail }) => ({ default: Mail })));
const MailInboxes = lazy(() => import('./pages/mail.jsx').then(({ MailInboxes }) => ({ default: MailInboxes })));

try { const t = localStorage.getItem('ka.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }

function App() {
  const { user, ready, can } = useAuth();
  if (!ready) return null;
  if (!user) return <Login />;
  return <WorkflowRoutes key={user._id} can={can} />;
}

function WorkflowRoutes({ can }) {
  const [store] = useState(createWorkflowStore);
  const mail = useApi('/settings/mail');
  const mailEnabled = mail.data?.enabled === true;
  const { reload } = mail;
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  async function saveMail(enabled) {
    await api('/settings/mail', { method: 'PUT', body: { enabled } });
    reload();
  }
  const guard = (ok, el) => (ok ? el : <Navigate to="/" replace />);
  return (
    <Provider store={store}>
      <Routes>
        <Route element={<Layout mailEnabled={mailEnabled} />}>
          <Route index element={can.super ? <Navigate to="/overview" replace /> : <MyWork />} />
          <Route path="daily-work" element={<DailyWork />} />
          <Route path="overview" element={guard(can.manage, <Overview />)} />
          <Route path="clients" element={<Clients />} />
          <Route path="clients/:id" element={<ClientDetail />} />
          <Route path="clients/:id/projects" element={<ClientProjects />} />
          <Route path="clients/:id/projects/:projectId" element={<ClientProjects />} />
          <Route path="mail" element={mail.loading ? <Skeleton /> : guard(mailEnabled, <Suspense fallback={<Skeleton />}><Mail /></Suspense>)} />
          <Route path="mail/inboxes" element={mail.loading ? <Skeleton /> : guard(can.manage && mailEnabled, <Suspense fallback={<Skeleton />}><MailInboxes /></Suspense>)} />
          <Route path="teams" element={<Navigate to="/clients" replace />} />
          <Route path="recurring" element={guard(can.manage, <Recurring />)} />
          <Route path="people" element={guard(can.super, <People />)} />
          <Route path="settings" element={guard(can.super, <Settings mail={mail} saveMail={saveMail} />)} />
          <Route path="access" element={guard(can.manage, <Access />)} />
          <Route path="audit" element={guard(can.manage, <Audit />)} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
