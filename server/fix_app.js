const fs = require('fs');
const path = require('path');

const appPath = path.resolve(__dirname, '../client/src/App.tsx');
let content = fs.readFileSync(appPath, 'utf8');

const startMarker = '{/* Personalization Card */}';
const endMarker = '{/* Proxy Configuration Card */}';

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
    console.log('Found duplicate block. Removing...');
    // We want to keep endMarker, but remove startMarker and everything up to endMarker.
    // However, we should also check indentation.
    // Let's just remove the slice.

    // Check if there is another occurrence later (the valid one)
    const nextStart = content.indexOf(startMarker, endIndex);
    if (nextStart !== -1) {
        console.log('Confirmed valid Personalization Card exists later.');

        // Remove from startIndex to endIndex (exclusive of endIndex, so Proxy card stays)
        // We probably want to remove the indentation before startMarker too?
        // Let's look at the newline before startIndex.

        const beforeContent = content.substring(0, startIndex);
        const lastNewLine = beforeContent.lastIndexOf('\n');

        // Remove from lastNewLine to endIndex
        // But endMarker should be preserved.
        // Actually, we can just replace the substring.

        const toRemove = content.substring(startIndex, endIndex);
        // We also want to eat valid whitespace lines if any.

        const newContent = content.slice(0, startIndex) + content.slice(endIndex);

        // This might leave a weird hole or extra spaces, but better than duplicate code.
        // Let's try to be cleaner: remove from the newline before startMarker up to newline before endMarker?

        // Simple string replacement
        const pattern = /\s+\{\/\* Personalization Card \*\/\}[\s\S]*?(?=\{\/\* Proxy Configuration Card \*\/})/m;
        const match = content.match(pattern);

        if (match && match.index === startIndex - (match[0].length - startMarker.length)) {
            // Regex match seems reliable for capturing the indentation
            const fixed = content.replace(pattern, '\n\n          ');
            fs.writeFileSync(appPath, fixed);
            console.log('Fixed App.tsx');
        } else {
            // Fallback to substring
            console.log('Regex failed, using substring splice (might leave whitespace)');
            // Find line start
            const lineStart = content.lastIndexOf('\n', startIndex);
            const fixed = content.substring(0, lineStart + 1) + '          ' + content.substring(endIndex);
            fs.writeFileSync(appPath, fixed);
            console.log('Fixed App.tsx');
        }

    } else {
        console.error('Did not find the second Personalization Card. Aborting to prevent deleting the only one.');
    }
} else {
    console.error('Could not find markers in expected order.');
    console.log('Start:', startIndex);
    console.log('End:', endIndex);
}
