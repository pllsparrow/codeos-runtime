import ProductNavigation from '@codeos/platform-core/ProductNavigation'
import LearningPaths from './LearningPaths'
import LearningHub from './LearningHub'
import KnowledgeHub from './KnowledgeHub'
import KnowledgeLibrary from './KnowledgeLibrary'
import ReadingWorkspace from './ReadingWorkspace'
import WritingWorkspace from './WritingWorkspace'
import { canonicalContentHref } from './contentRegistry'
import MentorWorkspace from './MentorWorkspace'
import PrepWorkspace from './PrepWorkspace'
import { useEffect, useState } from 'react'
import './workspaceNavigation.css'
function productHref(path: string): string {
  const configuredOrigin = import.meta.env.VITE_CODEOS_ORIGIN?.trim().replace(/\/$/, '')
  const directDevPort = ['8002', '8110', '8111'].includes(window.location.port)
  return `${configuredOrigin || (directDevPort ? 'http://127.0.0.1:8088' : '')}${path}`
}
export default function App() {
  const [, refreshContext] = useState(0)
  useEffect(() => { const refresh = () => refreshContext(value => value + 1); window.addEventListener('codeos:note-context', refresh); return () => window.removeEventListener('codeos:note-context', refresh) }, [])
  const pathname = window.location.pathname
  if (pathname.startsWith('/writing')) return <div className="learning-shell learning-writing-shell"><ProductNavigation active="writing" href={productHref} /><WritingWorkspace /></div>
  if (pathname.startsWith('/learning/library')) { window.location.replace(canonicalContentHref(window.location.href)); return null }
  let workspace
  if (/^\/learning\/courses\/[^/]+\/lessons\/\d+/.test(pathname)) workspace = <ReadingWorkspace noteId={Number(pathname.split('/')[5])} />
  else if (/^\/learning\/(?:knowledge\/(?:articles|notes)|read)\/\d+/.test(pathname)) workspace = <ReadingWorkspace noteId={Number(pathname.split('/').filter(Boolean).at(-1))} />
  else if (pathname.startsWith('/learning/courses/')) workspace = <LearningHub courseId={pathname.split('/')[3] || ''} />
  else if (pathname.startsWith('/learning/paths') || pathname.startsWith('/learning/algorithms') || pathname.startsWith('/learning/sql')) workspace = <LearningPaths />
  else if (pathname.startsWith('/learning/knowledge/practice')) workspace = <PrepWorkspace subjectTitle="Interview & Quizzes" returnHref="/learning/interviews" />
  else if (pathname.startsWith('/learning/knowledge/topics/')) workspace = <KnowledgeLibrary topicId={pathname.split('/')[4] || ''} />
  else if (pathname.startsWith('/learning/knowledge')) workspace = <KnowledgeLibrary />
  else if (pathname.startsWith('/learning/interviews')) workspace = <KnowledgeHub />
  else if (pathname.startsWith('/learning/notes')) {
    const target = canonicalContentHref(window.location.href)
    window.location.replace(target); return null
  }
  else if (pathname.startsWith('/learning/prep')) workspace = <PrepWorkspace />
  else if (pathname.startsWith('/learning/mentor')) workspace = <MentorWorkspace />
  else workspace = <LearningHub />
  return <div className="learning-shell"><ProductNavigation active={pathname.startsWith('/learning/knowledge') ? 'knowledge' : 'courses'} href={productHref} />{workspace}</div>
}
