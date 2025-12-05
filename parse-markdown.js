#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Parses a markdown file and extracts headers with their content
 * @param {string} content - The markdown file content
 * @returns {Object} - Object mapping headers to their descriptions
 */
function parseMarkdown(content) {
  const lines = content.split('\n');
  const result = {};
  let currentHeader = null;
  let currentContent = [];

  for (const line of lines) {
    // Check if line is a header (starts with #)
    if (line.match(/^#\s+(.+)$/)) {
      // Save previous header's content if exists
      if (currentHeader !== null) {
        result[currentHeader] = {
          description: currentContent.join('\n').trim()
        };
      }
      
      // Start new header
      currentHeader = line.replace(/^#\s+/, '');
      currentContent = [];
    } else if (currentHeader !== null) {
      // Accumulate content for current header
      currentContent.push(line);
    }
  }

  // Save the last header's content
  if (currentHeader !== null) {
    result[currentHeader] = {
      description: currentContent.join('\n').trim()
    };
  }

  return result;
}

/**
 * Main function
 */
async function main() {
  const inputFile = process.argv[2] || 'plans.md';
  const outputFile = process.argv[3] || 'output.json';

  try {
    // Read markdown file
    const content = await readFile(inputFile, 'utf-8');
    
    // Parse the markdown
    const parsed = parseMarkdown(content);
    
    // Write JSON output
    await writeFile(outputFile, JSON.stringify(parsed, null, 2), 'utf-8');
    
    console.log(`✓ Parsed ${inputFile} and wrote output to ${outputFile}`);
    console.log(`Found ${Object.keys(parsed).length} header(s)`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
