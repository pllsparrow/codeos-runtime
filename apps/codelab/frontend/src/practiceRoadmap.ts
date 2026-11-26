export type PracticeProblem = {
  index: number
  slug: string
  title: string
  difficulty: string
  category: string
  collection_name: string
  progress: string
}

export type RoadmapNode = {
  id: string
  title: string
  subtitle: string
  stage: string
  progress: number
  status: 'complete' | 'current' | 'next' | 'locked'
  problems: PracticeProblem[]
  accepted: number
  total: number
  firstProblemIndex?: number
  categories: string[]
  prerequisites: string[]
}

type RoadmapDefinition = Omit<RoadmapNode, 'progress' | 'status' | 'problems' | 'accepted' | 'total' | 'prerequisites'> & {
  categories: string[]
}

const roadmapDefinitions: RoadmapDefinition[] = [
  { id: 'acm-io', stage: '01 · Exam basics', title: 'ACM Input / Output', subtitle: 'Parse multi-line cases and print exact output', categories: ['ACM Input / Output'] },
  { id: 'simulation-strings', stage: '01 · Exam basics', title: 'Simulation & Strings', subtitle: 'Translate long rules into stable state changes', categories: ['Simulation', 'Strings'] },
  { id: 'sorting-hashing', stage: '02 · Data handling', title: 'Sorting & Hashing', subtitle: 'Aggregate, sort, deduplicate, and break ties', categories: ['Sorting', 'Arrays & Hashing', 'Hash Table', 'Buckets'] },
  { id: 'linear-scans', stage: '02 · Data handling', title: 'Two Pointers & Windows', subtitle: 'Control a changing range without rescanning', categories: ['Two Pointers', 'Sliding Window', 'Binary Search'] },
  { id: 'linear-structures', stage: '03 · Core structures', title: 'Stack, Queue & Heap', subtitle: 'Model order, nesting, and next-best candidates', categories: ['Stack', 'Linked List', 'Heap / Priority Queue'] },
  { id: 'trees-recursion', stage: '03 · Core structures', title: 'Trees & Recursion', subtitle: 'Make traversal and call-stack state explicit', categories: ['Trees', 'Recursion', 'Tries', 'Backtracking'] },
  { id: 'graphs', stage: '04 · Search and graphs', title: 'BFS, DFS & Graphs', subtitle: 'Handle grids, dependencies, and shortest paths', categories: ['Graph Traversal', 'Graphs', 'Advanced Graphs'] },
  { id: 'prefix-range', stage: '05 · Range techniques', title: 'Prefix Sum & Difference', subtitle: 'Turn repeated range work into preprocessing', categories: ['Prefix Sum', '2-D Prefix Sum', 'Prefix Sum + Hash Map', 'Difference Array'] },
  { id: 'greedy-scheduling', stage: '06 · Optimization', title: 'Greedy, Intervals & Scheduling', subtitle: 'Sort decisions and justify the local choice', categories: ['Greedy', 'Intervals', 'Greedy + Heap'] },
  { id: 'dynamic-programming', stage: '07 · Dynamic programming', title: '1-D & 2-D DP', subtitle: 'Define state, transition, order, and answer', categories: ['1-D Dynamic Programming', '2-D Dynamic Programming'] },
  { id: 'math-bits', stage: '08 · Supporting tools', title: 'Math & Bit Operations', subtitle: 'Use number properties and representations', categories: ['Math & Geometry', 'Bit Manipulation'] },
  { id: 'advanced-range', stage: '09 · Advanced patterns', title: 'Advanced Range Problems', subtitle: 'Combine compression, ordered state, and deques', categories: ['2-D Compression + Prefix Frequency', '2-D Compression + Ordered Prefixes', 'Prefix Sum + Monotonic Deque', '2-D Prefix Sum + Constrained Subarray'] },
]

export function buildRoadmapNodes(problems: PracticeProblem[]): RoadmapNode[] {
  const knownCategories = new Set(roadmapDefinitions.flatMap((definition) => definition.categories))
  const additionalDefinitions: RoadmapDefinition[] = Array.from(new Set(problems.map((problem) => problem.category).filter(Boolean)))
    .filter((category) => !knownCategories.has(category))
    .map((category) => ({
      id: `catalog-${category.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`,
      stage: '10 · Catalog extensions',
      title: category,
      subtitle: 'Continue with the next pattern in the catalog',
      categories: [category],
    }))
  const definitions = [...roadmapDefinitions, ...additionalDefinitions]
  const nodes = definitions.map((definition) => {
    const items = problems.filter((problem) => definition.categories.includes(problem.category))
    const accepted = items.filter((problem) => problem.progress === 'accepted').length
    const attempted = items.some((problem) => problem.progress && problem.progress !== 'todo')
    const progress = items.length ? Math.round((accepted / items.length) * 100) : 0
    return {
      ...definition,
      prerequisites: definition.id === 'acm-io' ? [] : ['ACM Input / Output'],
      progress,
      status: items.length > 0 && accepted === items.length ? 'complete' : attempted ? 'current' : 'next',
      problems: items,
      accepted,
      total: items.length,
      firstProblemIndex: (items.find((problem) => problem.progress !== 'accepted') || items[0])?.index,
    }
  })
  const firstIncomplete = nodes.findIndex((node) => node.status !== 'complete')
  return nodes.map((node, index) => ({
    ...node,
    status: node.status === 'complete' ? 'complete' : node.status === 'current' || index === firstIncomplete ? 'current' : 'next',
  }))
}
