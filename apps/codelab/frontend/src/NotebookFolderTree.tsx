import { useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'

type FolderNode = { path: string; name: string; count?: number; children: FolderNode[] }

function folderHierarchy(folders: { path: string; count: number }[]): FolderNode[] {
  const roots: FolderNode[] = []
  const nodes = new Map<string, FolderNode>()
  for (const folder of folders) {
    const parts = folder.path.split('/')
    let children = roots
    for (let depth = 0; depth < parts.length; depth++) {
      const path = parts.slice(0, depth + 1).join('/')
      let node = nodes.get(path)
      if (!node) {
        node = { path, name: parts[depth], children: [] }
        nodes.set(path, node)
        children.push(node)
      }
      if (depth === parts.length - 1) node.count = folder.count
      children = node.children
    }
  }
  return roots
}

function FolderBranch({ node, selected, onSelect }: { node: FolderNode; selected: string; onSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true)
  const groupId = useId()
  const parent = node.children.length > 0
  const active = selected === node.path
  const containsSelection = !active && selected.startsWith(`${node.path}/`)
  return <li className={`lab-folder-branch ${parent ? 'is-parent' : ''} ${containsSelection ? 'contains-selection' : ''}`}>
    <div className="lab-folder-row">
      {parent ? <button type="button" className="lab-folder-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`} aria-expanded={expanded} aria-controls={groupId} onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="lab-folder-toggle-spacer" aria-hidden="true" />}
      <button type="button" className={`lab-folder-item ${active ? 'active' : ''}`} aria-pressed={active} aria-label={`Filter notebooks in ${node.path}`} onClick={() => onSelect(node.path)} title={node.name}>
        <span className="lab-folder-name">{(parent && expanded) || active ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.name}</span></span>
        {node.count !== undefined && <span className="lab-folder-count">{node.count}</span>}
      </button>
    </div>
    {parent && <ul id={groupId} className="lab-folder-tree-children" hidden={!expanded} aria-label={`${node.name} subfolders`}>{node.children.map((child) => <FolderBranch key={child.path} node={child} selected={selected} onSelect={onSelect} />)}</ul>}
  </li>
}

export default function NotebookFolderTree({ folders, selected, onSelect }: { folders: { path: string; count: number }[]; selected: string; onSelect: (path: string) => void }) {
  const roots = useMemo(() => folderHierarchy(folders), [folders])
  return <nav aria-label="Folder hierarchy"><ul className="lab-folder-tree">{roots.map((node) => <FolderBranch key={node.path} node={node} selected={selected} onSelect={onSelect} />)}</ul></nav>
}
