import type {Metadata} from 'next';
import { Outfit, Playfair_Display } from 'next/font/google';
import './globals.css'; // Global styles

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-sans',
});

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'My Google AI Studio App',
  description: 'My Google AI Studio App',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${outfit.variable} ${playfair.variable}`}>
      <body suppressHydrationWarning>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var oldOnError = window.onerror;
                window.onerror = function(message, source, lineno, colno, error) {
                  if (message && (
                    message.includes('unexpected response') || 
                    message === 'Script error.' ||
                    message.includes('Unexpected response was received from the server') ||
                    message.includes('Failed to fetch')
                  )) {
                    console.warn('Silencing expected or caught network error:', message);
                    return true;
                  }
                  if (oldOnError) return oldOnError.apply(this, arguments);
                };

                window.addEventListener('unhandledrejection', function(event) {
                  if (event.reason && (
                    event.reason.name === 'TypeError' && 
                    (event.reason.message === 'Failed to fetch' || event.reason.message.includes('fetch'))
                  )) {
                    console.warn('Caught unhandled fetch rejection:', event.reason.message);
                    event.preventDefault(); // Prevent it from bubbling up as an Uncaught error
                  }
                });
              })();
            `
          }}
        />
      </body>
    </html>
  );
}
