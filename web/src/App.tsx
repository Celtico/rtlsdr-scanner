import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { Spectrum } from '@/pages/Spectrum';
import { Devices } from '@/pages/Devices';
import { Planes } from '@/pages/Planes';
import { History } from '@/pages/History';
import { Audit } from '@/pages/Audit';
import { Hunt } from '@/pages/Hunt';
import { Satellites } from '@/pages/Satellites';
import { Dab } from '@/pages/Dab';
import { Noise } from '@/pages/Noise';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="espectre" element={<Spectrum />} />
        <Route path="dispositius" element={<Devices />} />
        <Route path="avions" element={<Planes />} />
        <Route path="radar" element={<Navigate to="/avions?tab=radar" replace />} />
        <Route path="auditoria" element={<Audit />} />
        <Route path="hunt" element={<Hunt />} />
        <Route path="satellits" element={<Satellites />} />
        <Route path="dab" element={<Dab />} />
        <Route path="soroll" element={<Noise />} />
        <Route path="historic" element={<History />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
