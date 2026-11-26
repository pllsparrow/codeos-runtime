import HomeWorkspace from '../personal_space/HomeWorkspace'

export default function TodayView({ onNavigate }: { onNavigate: (path: string) => void }) {
  return <HomeWorkspace onNavigate={onNavigate} />
}
