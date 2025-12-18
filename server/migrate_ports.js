const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(DATA_FILE)) {
    console.log('No data file found.');
    process.exit(0);
}

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
let changed = false;

if (!data.instances) {
    console.log('No instances found.');
    process.exit(0);
}

const usedPorts = new Set(data.instances.map(i => i.llonebotPort).filter(p => p));

data.instances.forEach(inst => {
    if (!inst.llonebotPort) {
        let port = 3000;
        while (usedPorts.has(port)) {
            port++;
        }
        inst.llonebotPort = port;
        usedPorts.add(port);
        console.log(`Assigned port ${port} to instance ${inst.name}`);
        changed = true;
    }
});

if (changed) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('Migration complete. Data saved.');
} else {
    console.log('No migration needed.');
}
