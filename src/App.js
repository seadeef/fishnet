import React, { useEffect, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { REGION, USER_POOL_ID, IDENTITY_POOL_ID, BUCKET_NAME } from './config';
import './App.css';

function EmailReviewer({ emailKey, onVerdictSubmit, auth }) {
  const [emailContent, setEmailContent] = useState(null);
  const [parsedEmail, setParsedEmail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [verdict, setVerdict] = useState('SAFE');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchEmailContent = async () => {
      try {
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

        const response = await s3.send(new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: emailKey,
        }));

        const content = await response.Body.transformToString();
        console.log('Raw email content:', content); // Debug log
        setEmailContent(content);
        
        // Parse the email content
        const parsed = parseEmail(content);
        console.log('Parsed email:', parsed); // Debug log
        setParsedEmail(parsed);
      } catch (err) {
        console.error('Error fetching email:', err);
        setError(err.message || 'Failed to fetch email content');
      } finally {
        setLoading(false);
      }
    };

    fetchEmailContent();
  }, [emailKey, auth.user.id_token]);

  // Function to decode email content
  const decodeEmailContent = (content) => {
    try {
      // First, decode quoted-printable encoding
      let decoded = content
        .replace(/=\r\n/g, '')  // Remove soft line breaks
        .replace(/=\n/g, '')    // Remove soft line breaks
        .replace(/=([0-9A-F]{2})/gi, (match, p1) => {
          return String.fromCharCode(parseInt(p1, 16));
        });

      // Handle UTF-8 encoded content
      if (decoded.includes('Â')) {
        // If we see UTF-8 BOM or other UTF-8 artifacts, try to clean them up
        decoded = decoded
          .replace(/\u00C2\u00A0/g, ' ')  // Replace UTF-8 encoded non-breaking space
          .replace(/\u00C2/g, '')         // Remove UTF-8 continuation byte
          .replace(/\u00A0/g, ' ')        // Replace non-breaking space
          .replace(/&nbsp;/g, ' ')        // Replace HTML non-breaking space
          .replace(/\s+/g, ' ')           // Normalize spaces
          .trim();
      }

      // Additional cleanup
      decoded = decoded
        .replace(/\uFEFF/g, '')           // Remove BOM
        .replace(/\u200B/g, '')           // Remove zero-width space
        .replace(/\u200C/g, '')           // Remove zero-width non-joiner
        .replace(/\u200D/g, '')           // Remove zero-width joiner
        .replace(/\u200E/g, '')           // Remove left-to-right mark
        .replace(/\u200F/g, '')           // Remove right-to-left mark
        .replace(/\s+/g, ' ')             // Normalize spaces again
        .trim();

      return decoded;
    } catch (err) {
      console.error('Error decoding email content:', err);
      return content; // Return original content if decoding fails
    }
  };

  // Function to parse email content
  const parseEmail = (content) => {
    try {
      // Normalize line endings
      const normalizedContent = content.replace(/\r\n/g, '\n');
      
      // Split headers and body
      const parts = normalizedContent.split('\n\n');
      const headersRaw = parts[0];
      const body = parts.slice(1).join('\n\n');

      // Parse headers
      const headers = {};
      const headerLines = headersRaw.split('\n');
      
      let currentHeader = '';
      let currentValue = '';
      
      headerLines.forEach(line => {
        // Handle multi-line headers
        if (line.startsWith(' ') || line.startsWith('\t')) {
          // This is a continuation of the previous header
          if (currentHeader) {
            currentValue += ' ' + line.trim();
            headers[currentHeader] = decodeEmailContent(currentValue);
          }
        } else {
          // If we have a previous header, save it
          if (currentHeader) {
            headers[currentHeader] = decodeEmailContent(currentValue);
          }
          
          // Start new header
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) {
            const [, key, value] = match;
            currentHeader = key.trim();
            currentValue = value.trim();
            headers[currentHeader] = decodeEmailContent(currentValue);
          }
        }
      });

      // Save the last header if exists
      if (currentHeader) {
        headers[currentHeader] = decodeEmailContent(currentValue);
      }

      // Extract MIME parts
      let plainText = '';
      let htmlContent = '';
      
      if (headers['Content-Type']?.includes('multipart/alternative')) {
        // Split by MIME boundary
        const boundary = headers['Content-Type'].match(/boundary="([^"]+)"/)?.[1];
        if (boundary) {
          const mimeParts = body.split(`--${boundary}`);
          
          mimeParts.forEach(part => {
            if (part.includes('Content-Type: text/plain')) {
              // Extract plain text content
              const textMatch = part.match(/Content-Type: text\/plain[^]*?\n\n([^]*?)(?=--|$)/s);
              if (textMatch) {
                plainText = decodeEmailContent(textMatch[1].trim());
              }
            } else if (part.includes('Content-Type: text/html')) {
              // Extract HTML content
              const htmlMatch = part.match(/Content-Type: text\/html[^]*?\n\n([^]*?)(?=--|$)/s);
              if (htmlMatch) {
                htmlContent = decodeEmailContent(htmlMatch[1].trim());
              }
            }
          });
        }
      } else {
        // Not multipart, use the body as is
        plainText = decodeEmailContent(body);
      }

      // Clean up HTML content
      let cleanHtml = htmlContent;
      if (htmlContent) {
        cleanHtml = htmlContent
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove style tags
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script tags
          .replace(/<div[^>]*>/gi, '') // Remove div tags
          .replace(/<\/div>/gi, '\n') // Replace closing divs with newlines
          .replace(/<br\s*\/?>/gi, '\n') // Replace br tags with newlines
          .replace(/<[^>]+>/g, '') // Remove other HTML tags
          .replace(/\n\s*\n/g, '\n\n') // Normalize multiple newlines
          .trim();
      }

      // Use HTML content if available, otherwise use plain text
      const displayContent = cleanHtml || plainText;

      // Extract date from headers
      let date = 'Unknown date';
      if (headers['Date']) {
        try {
          const dateObj = new Date(headers['Date']);
          if (!isNaN(dateObj.getTime())) {
            date = dateObj.toLocaleString();
          }
        } catch (e) {
          console.error('Error parsing date:', e);
        }
      }

      const parsed = {
        headers,
        body: displayContent,
        isHtml: !!htmlContent,
        date: date,
        from: headers['From'] || 'Unknown sender',
        to: headers['To'] || 'Unknown recipient',
        subject: headers['Subject'] || 'No subject',
        rawContent: content,
      };

      console.log('Final parsed result:', parsed);
      return parsed;
    } catch (err) {
      console.error('Error parsing email:', err);
      return {
        headers: {},
        body: content,
        isHtml: false,
        date: 'Unknown date',
        from: 'Unknown sender',
        to: 'Unknown recipient',
        subject: 'No subject',
        rawContent: content,
      };
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onVerdictSubmit(emailKey, verdict, comment);
    } catch (err) {
      setError(err.message || 'Failed to submit verdict');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="loading">Loading email content...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div className="email-reviewer">
      <div className="email-content">
        <div className="email-header">
          <h3>{parsedEmail.subject}</h3>
          <div className="email-meta">
            <div className="meta-row">
              <span className="meta-label">From:</span>
              <span className="meta-value">{parsedEmail.from}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">To:</span>
              <span className="meta-value">{parsedEmail.to}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">Date:</span>
              <span className="meta-value">{parsedEmail.date}</span>
            </div>
          </div>
        </div>
        <div className="email-body">
          {parsedEmail.isHtml ? (
            <div className="html-content">
              {parsedEmail.body.split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          ) : (
            <pre>{parsedEmail.body}</pre>
          )}
        </div>
      </div>
      <form onSubmit={handleSubmit} className="verdict-form">
        <div className="form-group">
          <label>Verdict:</label>
          <select 
            value={verdict} 
            onChange={(e) => setVerdict(e.target.value)}
            disabled={submitting}
          >
            <option value="SAFE">Safe</option>
            <option value="SPAM">Spam</option>
          </select>
        </div>
        <div className="form-group">
          <label>Comment:</label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Enter your comment (e.g., 'proceed with caution')"
            disabled={submitting}
            required
          />
        </div>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Submitting...' : 'Submit Verdict'}
        </button>
      </form>
    </div>
  );
}

function App() {
  const auth = useAuth();
  const [keys, setKeys] = useState([]);
  const [emailMetadata, setEmailMetadata] = useState({});
  const [error, setError] = useState(null);
  const [selectedEmail, setSelectedEmail] = useState(null);

  // Function to fetch email metadata
  const fetchEmailMetadata = async (key) => {
    try {
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

      const response = await s3.send(new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }));

      const content = await response.Body.transformToString();
      const normalizedContent = content.replace(/\r\n/g, '\n');
      const headersRaw = normalizedContent.split('\n\n')[0];
      
      // Parse headers
      const headers = {};
      const headerLines = headersRaw.split('\n');
      
      let currentHeader = '';
      let currentValue = '';
      
      headerLines.forEach(line => {
        if (line.startsWith(' ') || line.startsWith('\t')) {
          if (currentHeader) {
            currentValue += ' ' + line.trim();
            headers[currentHeader] = currentValue;
          }
        } else {
          if (currentHeader) {
            headers[currentHeader] = currentValue;
          }
          
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) {
            const [, key, value] = match;
            currentHeader = key.trim();
            currentValue = value.trim();
            headers[currentHeader] = currentValue;
          }
        }
      });

      if (currentHeader) {
        headers[currentHeader] = currentValue;
      }

      return {
        subject: headers['Subject'] || 'No Subject',
        from: headers['From'] || 'Unknown Sender',
        date: headers['Date'] || 'Unknown Date',
      };
    } catch (err) {
      console.error('Error fetching email metadata:', err);
      return {
        subject: 'Error loading email',
        from: 'Unknown Sender',
        date: 'Unknown Date',
      };
    }
  };

  useEffect(() => {
    if (!auth.isAuthenticated) return;

    const client = new S3Client({
      region: REGION,
      credentials: fromCognitoIdentityPool({
        client: new CognitoIdentityClient({ region: REGION }),
        identityPoolId: IDENTITY_POOL_ID,
        logins: {
          [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: auth.user.id_token,
        },
      }),
    });

    // List all objects in the bucket
    client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME }))
      .then(async data => {
        const keys = data.Contents?.map(o => o.Key) || [];
        setKeys(keys);
        
        // Fetch metadata for each email
        const metadata = {};
        for (const key of keys) {
          metadata[key] = await fetchEmailMetadata(key);
        }
        setEmailMetadata(metadata);
      })
      .catch(err => {
        console.error('Error listing S3 objects:', err);
        setError(err.message || 'Unknown error');
      });
  }, [auth]);

  const handleVerdictSubmit = async (emailKey, verdict, comment) => {
    try {
      const lambda = new LambdaClient({
        region: REGION,
        credentials: fromCognitoIdentityPool({
          client: new CognitoIdentityClient({ region: REGION }),
          identityPoolId: IDENTITY_POOL_ID,
          logins: {
            [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: auth.user.id_token,
          },
        }),
      });

      const command = new InvokeCommand({
        FunctionName: 'send-email',
        Payload: JSON.stringify({
          key: emailKey,
          verdict,
          comment,
        }),
      });

      const response = await lambda.send(command);
      const responsePayload = JSON.parse(new TextDecoder().decode(response.Payload));
      
      if (response.FunctionError) {
        throw new Error(responsePayload.error || 'Lambda function error');
      }

      // Remove the reviewed email from the list
      setKeys(prevKeys => prevKeys.filter(key => key !== emailKey));
      setSelectedEmail(null);
    } catch (err) {
      console.error('Error submitting verdict:', err);
      throw new Error(`Failed to submit verdict: ${err.message}`);
    }
  };

  if (auth.isLoading) return <div className="loading">Loading authentication...</div>;
  if (auth.error) return <div className="error">Error: {auth.error.message}</div>;

  if (!auth.isAuthenticated) {
    return (
      <div className="login-container">
        <h1>Fishnet</h1>
        <button onClick={() => auth.signinRedirect()} className="login-button">
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>Fishnet</h1>
        <div className="user-info">
          <span>Welcome, {auth.user.profile.email}</span>
          <button onClick={() => auth.removeUser()} className="signout-button">
            Sign Out
          </button>
        </div>
      </header>

      <main className="main-content">
        <div className="email-list">
          <h2>Pending Reviews</h2>
          {error && <p className="error">Error: {error}</p>}
          {!error && keys.length === 0 ? (
            <p className="no-emails">No emails to review</p>
          ) : (
            <ul>
              {keys.map(key => {
                const metadata = emailMetadata[key] || { subject: 'Loading...', from: 'Loading...', date: 'Loading...' };
                return (
                  <li 
                    key={key}
                    className={selectedEmail === key ? 'selected' : ''}
                    onClick={() => setSelectedEmail(key)}
                  >
                    <div className="email-list-item">
                      <div className="email-subject">{metadata.subject}</div>
                      <div className="email-meta">
                        <span className="email-from">{metadata.from}</span>
                        <span className="email-date">{metadata.date}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selectedEmail && (
          <div className="review-panel">
            <EmailReviewer
              emailKey={selectedEmail}
              onVerdictSubmit={handleVerdictSubmit}
              auth={auth}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
