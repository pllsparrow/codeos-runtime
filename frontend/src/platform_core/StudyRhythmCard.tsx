import { CalendarDays, Flame } from 'lucide-react'
import './StudyRhythmCard.css'

export type StudyRhythmDay = {
  label: string
  active: boolean
  date?: string
}

export type StudyRhythmCardProps = {
  streak: number | null
  days: StudyRhythmDay[]
  nextSession: string
  className?: string
}

export default function StudyRhythmCard({ streak, days, nextSession, className = '' }: StudyRhythmCardProps) {
  const daySummary = streak === null ? 'Study activity is not connected' : `${days.filter((day) => day.active).length} active days in the current rhythm window`
  return (
    <section className={`platform-study-rhythm-card ${className}`.trim()} aria-label="Study rhythm">
      <div className="platform-study-rhythm-summary">
        <span className="platform-study-rhythm-icon" aria-hidden="true"><CalendarDays size={17} /></span>
        <span className="platform-study-rhythm-copy">
          <small>STUDY RHYTHM</small>
          <strong><Flame size={14} aria-hidden="true" /> {streak === null ? 'Not connected' : `${streak} day streak`}</strong>
          <em>{nextSession}</em>
        </span>
      </div>
      <div className="platform-study-rhythm-days" aria-label={daySummary}>
        {days.map((day, index) => <span className={`platform-study-rhythm-day ${day.active ? 'is-active' : ''}`} key={`${day.label}-${index}`} title={day.date || day.label}>
          <span>{day.label}</span>
          <i aria-hidden="true" />
        </span>)}
      </div>
    </section>
  )
}
