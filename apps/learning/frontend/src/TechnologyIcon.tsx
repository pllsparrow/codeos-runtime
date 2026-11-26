import { Bot, Cpu, Network, Search, Terminal } from 'lucide-react'

const brands: Record<string, string> = {
  python: new URL('./assets/technology-icons/python.svg', import.meta.url).href,
  go: new URL('./assets/technology-icons/go.svg', import.meta.url).href,
  docker: new URL('./assets/technology-icons/docker.svg', import.meta.url).href,
  git: new URL('./assets/technology-icons/git.svg', import.meta.url).href,
  databases: new URL('./assets/technology-icons/postgresql.svg', import.meta.url).href,
  linux: new URL('./assets/technology-icons/linux.svg', import.meta.url).href,
  fastapi: new URL('./assets/technology-icons/fastapi.svg', import.meta.url).href,
}
const aliases: Record<string, string> = { 'python-language': 'python', 'python-web': 'fastapi', 'async-python': 'fastapi', 'go-language': 'go', 'go-codeosctl': 'go', sql: 'databases' }
export default function TechnologyIcon({ technology }: { technology: string }) {
  const key = aliases[technology] || technology
  if (brands[key]) return <img className="technology-brand-icon" src={brands[key]} alt="" aria-hidden="true" width={40} height={40} />
  const Icon = key === 'operating-systems' ? Cpu : key === 'http' || key === 'http-networks' ? Network : key === 'agents' || key === 'ai-agents' ? Bot : key === 'rag' ? Search : Terminal
  return <Icon aria-hidden="true" />
}
