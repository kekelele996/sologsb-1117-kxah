import { Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from '@/App'
import SchedulePage from '@/pages/SchedulePage'
import OrchardsPage from '@/pages/OrchardsPage'
import ColoniesPage from '@/pages/ColoniesPage'
import AvoidancePage from '@/pages/AvoidancePage'
import RoutesPage from '@/pages/RoutesPage'
import ExportPage from '@/pages/ExportPage'

/** 前端路由：/ /orchards /colonies /avoidance /routes /export */
export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<SchedulePage />} />
        <Route path="/orchards" element={<OrchardsPage />} />
        <Route path="/colonies" element={<ColoniesPage />} />
        <Route path="/avoidance" element={<AvoidancePage />} />
        <Route path="/routes" element={<RoutesPage />} />
        <Route path="/export" element={<ExportPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
