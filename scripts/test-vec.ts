import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const db = new Database(':memory:')
sqliteVec.load(db)

// Create a simple test table
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS test_vec USING vec0(embedding float[4])`)

// Try inserting
const emb = new Float32Array([0.1, 0.2, 0.3, 0.4])
console.log('Embedding type:', typeof emb)
console.log('Embedding:', emb)

try {
  // Insert without explicit rowid
  const result = db.prepare('INSERT INTO test_vec(embedding) VALUES (?)').run(emb)
  console.log('Insert result:', result)
  
  // Try with explicit rowid
  const result2 = db.prepare('INSERT INTO test_vec(rowid, embedding) VALUES (?, ?)').run(42, emb)
  console.log('Insert with rowid result:', result2)
  
  // Query back
  const rows = db.prepare('SELECT rowid, * FROM test_vec').all()
  console.log('Rows:', rows)
  
  // Try a match query
  const query = new Float32Array([0.1, 0.2, 0.3, 0.4])
  const matched = db.prepare('SELECT rowid, distance FROM test_vec WHERE embedding MATCH ? LIMIT 1').all(query)
  console.log('Matched:', matched)
} catch (e) {
  console.error('Error:', e)
}
