import type { ReactNode } from 'react'
import { BookOpen, Code2, Library, Trophy, BriefcaseBusiness, Sun, UserRound, PenLine } from 'lucide-react'
import ThemeControl from './ThemeControl'
import WorkbenchMenu from './WorkbenchMenu'
import './product-navigation.css'
const learningEdition = import.meta.env.VITE_CODEOS_LEARNING_EDITION === 'true'
const destinations = [
  { id: 'courses', label: 'Courses', path: '/learning/', icon: BookOpen },
  { id: 'lab', label: 'Lab', path: learningEdition ? '/codelab/jupy' : '/codelab/lab', icon: Code2 },
  { id: 'oj', label: 'OJ', path: '/codelab/oj', icon: Trophy },
  { id: 'knowledge', label: 'Knowledge', path: '/learning/knowledge/', icon: Library },
]
export default function ProductNavigation({ active, href = value => value, children }: { active?: string; href?: (path: string) => string; children?: ReactNode }) {
  return <header className="codeos-navigation" aria-label="CodeOS product navigation"><a className="codeos-navigation-brand" href={href('/')}>CodeOS</a><nav aria-label="Learning destinations">{destinations.filter(item => !learningEdition || item.id !== 'oj').map(item => <a key={item.id} href={href(item.path)} className={active === item.id ? 'active' : undefined} aria-current={active === item.id ? 'page' : undefined}><item.icon size={16} aria-hidden="true" />{item.label}</a>)}</nav><div className="codeos-navigation-utilities"><a className="codeos-writing" aria-current={active === 'writing' ? 'page' : undefined} href={href('/writing/')} target="_blank" rel="noopener noreferrer"><PenLine size={16} aria-hidden="true" />Notes</a><div className="codeos-settings"><WorkbenchMenu label="Appearance" icon={<Sun size={17} />}><span className="codeos-menu-heading">Appearance</span><ThemeControl /></WorkbenchMenu>{children && <WorkbenchMenu label="Account" icon={<UserRound size={17} />}><span className="codeos-menu-heading">Account</span>{children}</WorkbenchMenu>}</div>{!learningEdition && <a className={`codeos-career${active === 'career' ? ' active' : ''}`} aria-current={active === 'career' ? 'page' : undefined} href={href('/career/')}><BriefcaseBusiness size={16} aria-hidden="true" />Career</a>}</div></header>
}
