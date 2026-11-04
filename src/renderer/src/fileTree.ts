// Folder tree of file paths, shared by the Code view and the Files list.

export interface Dir {
  name: string
  path: string
  dirs: Dir[]
  files: string[]
}

export function buildTree(paths: string[]): Dir {
  const root: Dir = { name: '', path: '', dirs: [], files: [] }
  const index = new Map<string, Dir>([['', root]])
  for (const p of paths) {
    const parts = p.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = index.get(path)
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [] }
        index.set(path, next)
        cur.dirs.push(next)
      }
      cur = next
    }
    cur.files.push(p)
  }
  const sort = (d: Dir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name))
    d.files.sort((a, b) => a.localeCompare(b))
    d.dirs.forEach(sort)
  }
  sort(root)
  return root
}

/** Folders with a single folder inside are shown as one row ("src/main"), like most IDEs. */
export function compact(d: Dir): Dir {
  let cur = d
  while (cur.files.length === 0 && cur.dirs.length === 1) {
    const child = cur.dirs[0]
    cur = { ...child, name: `${cur.name}/${child.name}` }
  }
  return cur
}
