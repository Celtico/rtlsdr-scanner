import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Provider } from '@/components/ui/provider';
import { SdrProvider } from '@/store';
import { App } from '@/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider>
      <BrowserRouter>
        <SdrProvider>
          <App />
        </SdrProvider>
      </BrowserRouter>
    </Provider>
  </StrictMode>,
);
