import { ArrowLeft, BriefcaseBusiness, Sun } from 'lucide-react'
import ThemeControl from './ThemeControl'
import WorkbenchMenu from './WorkbenchMenu'
import './product-navigation.css'
import './career-navigation.css'

export default function CareerNavigation({ href = value => value }: { href?: (path: string) => string }) {
  return <header className="codeos-navigation career-product-navigation" aria-label="Career navigation">
    <a className="career-navigation-brand" href={href('/career/')}><BriefcaseBusiness size={21} aria-hidden="true" /><strong>Career</strong></a>
    <div className="codeos-navigation-utilities">
      <div className="codeos-settings"><WorkbenchMenu label="Appearance" icon={<Sun size={17} />}><span className="codeos-menu-heading">Appearance</span><ThemeControl /></WorkbenchMenu></div>
      <a className="career-learning-return" href={href('/learning/')}><ArrowLeft size={15} aria-hidden="true" />Back to CodeOS</a>
    </div>
  </header>
}
