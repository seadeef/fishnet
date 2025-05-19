import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from 'react-oidc-context';
import { COGNITO_DOMAIN, USER_POOL_CLIENT_ID, REDIRECT_URI } from './config';

const cognitoAuthConfig = {
  authority: COGNITO_DOMAIN,
  client_id: USER_POOL_CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: 'openid profile email',
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <AuthProvider {...cognitoAuthConfig}>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
