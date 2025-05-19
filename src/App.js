import React, { useEffect, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { REGION, USER_POOL_ID, IDENTITY_POOL_ID, BUCKET_NAME } from './config';
import './App.css';

// Utility functions for email parsing
const decodeMimeHeader = (header) => {
  if (!header) return '';
  
  // Handle multiple MIME encoded parts
  let decoded = header.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (match, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        // Base64 decoding
        const binary = atob(encoded.replace(/\s/g, ''));
        // Convert binary string to UTF-8
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const decoded = new TextDecoder('utf-8').decode(bytes);
        // Remove any zero-width spaces or other invisible characters
        return decoded.replace(/[\u200B-\u200D\uFEFF]/g, '');
      } else {
        // Quoted-Printable decoding
        return encoded
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => {
            return String.fromCharCode(parseInt(hex, 16));
          })
          .replace(/_/g, ' ');
      }
    } catch (err) {
      console.error('Error decoding MIME header:', err);
      return match;
    }
  });

  // Clean up any remaining encoding artifacts and spaces
  return decoded
    .replace(/\u00E2\u0080\u0099/g, "'")  // Replace UTF-8 encoded apostrophe
    .replace(/\u00E2\u0080\u009C/g, '"')  // Replace UTF-8 encoded left quote
    .replace(/\u00E2\u0080\u009D/g, '"')  // Replace UTF-8 encoded right quote
    .replace(/\u00E2\u0080\u0093/g, '–')  // Replace UTF-8 encoded en dash
    .replace(/\u00E2\u0080\u0094/g, '—')  // Replace UTF-8 encoded em dash
    .replace(/[\u200B-\u200D\uFEFF]/g, '')  // Remove zero-width spaces and other invisible characters
    .replace(/\s+/g, ' ')                 // Normalize spaces
    .replace(/\s+([.,;:!?])/g, '$1')      // Remove spaces before punctuation
    .replace(/([.,;:!?])\s+/g, '$1 ')     // Ensure single space after punctuation
    .replace(/\s+([a-z])/g, ' $1')        // Ensure space before lowercase letters
    .replace(/([a-z])\s+([A-Z])/g, '$1 $2') // Ensure space between words
    .trim();
};

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
          if (currentHeader) {
            currentValue += ' ' + line.trim();
            headers[currentHeader] = decodeEmailContent(currentValue);
          }
        } else {
          if (currentHeader) {
            headers[currentHeader] = decodeEmailContent(currentValue);
          }
          
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) {
            const [, key, value] = match;
            currentHeader = key.trim();
            currentValue = value.trim();
            headers[currentHeader] = decodeEmailContent(currentValue);
          }
        }
      });

      if (currentHeader) {
        headers[currentHeader] = decodeEmailContent(currentValue);
      }

      console.log('Content-Type header:', headers['Content-Type']); // Debug log

      // Extract MIME parts
      let plainText = '';
      let htmlContent = '';
      
      // Check if it's a multipart message
      if (headers['Content-Type']?.toLowerCase().includes('multipart')) {
        console.log('Processing multipart message'); // Debug log
        const boundaryMatch = headers['Content-Type'].match(/boundary="?([^";\s]+)"?/i);
        if (boundaryMatch) {
          const boundary = boundaryMatch[1];
          console.log('Found boundary:', boundary); // Debug log
          
          const mimeParts = body.split(`--${boundary}`);
          console.log('Number of MIME parts:', mimeParts.length); // Debug log
          
          mimeParts.forEach((part, index) => {
            console.log(`Processing part ${index}:`, part.substring(0, 100)); // Debug log first 100 chars
            
            if (part.toLowerCase().includes('content-type: text/plain')) {
              const textMatch = part.match(/Content-Type: text\/plain[^]*?\n\n([^]*?)(?=--|$)/is);
              if (textMatch) {
                plainText = decodeEmailContent(textMatch[1].trim());
                console.log('Found plain text content'); // Debug log
              }
            } else if (part.toLowerCase().includes('content-type: text/html')) {
              const htmlMatch = part.match(/Content-Type: text\/html[^]*?\n\n([^]*?)(?=--|$)/is);
              if (htmlMatch) {
                htmlContent = decodeEmailContent(htmlMatch[1].trim());
                console.log('Found HTML content'); // Debug log
              }
            }
          });
        }
      } else if (headers['Content-Type']?.toLowerCase().includes('text/html')) {
        // Direct HTML content
        console.log('Processing direct HTML content'); // Debug log
        htmlContent = decodeEmailContent(body);
      } else {
        // Plain text content
        console.log('Processing plain text content'); // Debug log
        plainText = decodeEmailContent(body);
      }

      console.log('HTML content found:', !!htmlContent); // Debug log
      console.log('Plain text content found:', !!plainText); // Debug log

      // Clean up HTML content if we have it
      if (htmlContent) {
        // Remove potentially dangerous elements and attributes
        const cleanHtml = htmlContent
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Remove style tags
          .replace(/on\w+="[^"]*"/g, '') // Remove on* attributes
          .replace(/on\w+='[^']*'/g, '') // Remove on* attributes with single quotes
          .replace(/javascript:/gi, '') // Remove javascript: URLs
          .trim();
        
        htmlContent = cleanHtml;
      }

      // Use HTML content if available, otherwise use plain text
      const displayContent = htmlContent || plainText;
      const isHtml = !!htmlContent;

      console.log('Final content type:', isHtml ? 'HTML' : 'Plain text'); // Debug log

      // After parsing headers, decode any MIME encoded headers
      const decodedHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        // Handle multiple encoded parts in the same header
        let decodedValue = value;
        let lastDecoded = '';
        // Keep decoding until no more changes (handles multiple encoded parts)
        while (decodedValue !== lastDecoded) {
          lastDecoded = decodedValue;
          decodedValue = decodeMimeHeader(decodedValue);
        }
        decodedHeaders[key] = decodedValue;
      }

      const parsed = {
        headers: decodedHeaders,  // Use decoded headers
        body: displayContent,
        isHtml,
        date: decodedHeaders['Date'] || 'Unknown date',
        from: decodedHeaders['From'] || 'Unknown sender',
        to: decodedHeaders['To'] || 'Unknown recipient',
        subject: decodedHeaders['Subject'] || 'No subject',
        rawContent: content,
      };

      console.log('Decoded subject:', decodedHeaders['Subject']); // Debug log

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
            <div 
              className="html-content"
              dangerouslySetInnerHTML={{ __html: parsedEmail.body }}
            />
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

      // Decode headers using the same function as the email preview
      const decodedHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        let decodedValue = value;
        let lastDecoded = '';
        while (decodedValue !== lastDecoded) {
          lastDecoded = decodedValue;
          decodedValue = decodeMimeHeader(decodedValue);
        }
        decodedHeaders[key] = decodedValue;
      }

      return {
        subject: decodedHeaders['Subject'] || 'No Subject',
        from: decodedHeaders['From'] || 'Unknown Sender',
        date: decodedHeaders['Date'] || 'Unknown Date',
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
