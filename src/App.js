import React, { useEffect, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { REGION, USER_POOL_ID, IDENTITY_POOL_ID, BUCKET_NAME } from './config';

function App() {
  const auth = useAuth();
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!auth.isAuthenticated) return;

    const s3 = new S3Client({
      region: REGION,
      credentials: fromCognitoIdentityPool({
        client: new CognitoIdentityClient({ region: REGION }),
        identityPoolId: IDENTITY_POOL_ID,
        logins: {
          [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: auth.user.id_token,
        },
      }),
    });

    // List all objects in the bucket (no prefix)
    s3.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME }))
      .then(data => setKeys(data.Contents?.map(o => o.Key) || []))
      .catch(err => {
        console.error('Error listing S3 objects:', err);
        setError(err.message || 'Unknown error');
      });
  }, [auth]);

  if (auth.isLoading) return <div>Loading authentication...</div>;
  if (auth.error)      return <div>Error: {auth.error.message}</div>;

  if (!auth.isAuthenticated) {
    return <button onClick={() => auth.signinRedirect()}>Sign In</button>;
  }

  return (
    <div style={{ padding: '1rem' }}>
      <h1>Welcome, {auth.user.profile.email}</h1>
      <button onClick={() => auth.removeUser()}>Sign Out</button>
      <h2>S3 Objects in bucket "{BUCKET_NAME}":</h2>
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {!error && keys.length === 0 ? (
        <p>No objects found</p>
      ) : (
        <ul>
          {keys.map(key => <li key={key}>{key}</li>)}
        </ul>
      )}
    </div>
  );
}

export default App;
