'use strict';
// Demo data: three colleges, one of them (SRM VEC) with departments, staff, students,
// a timetable, cameras and ten days of attendance. Run on an empty, migrated database.
const db = require('../src/config/db');
const { seedDemo, PASSWORDS } = require('./lib/demo');

seedDemo()
  .then(() => {
    console.log('\nDemo ready. Sign in at /login:');
    console.log('  College                 Username             Password');
    console.log(`  Group administration    superadmin           ${PASSWORDS.superadmin}`);
    console.log(`  SRM VEC                 admin                ${PASSWORDS.admin}`);
    console.log(`  SRM VEC                 hod.cse              ${PASSWORDS.hod}`);
    console.log(`  SRM VEC                 cse.staff1           ${PASSWORDS.staff}`);
    console.log(`  SRM VEC                 vec26cse3a001        ${PASSWORDS.student}   (register number, lower case; the year digits follow the current academic year)`);
    console.log(`  SRM IST / SRMIST Ramapuram   admin           ${PASSWORDS.admin}   (empty colleges, to see isolation)`);
    console.log('\nChange these passwords before any real use.');
  })
  .then(() => db.end())
  .catch((err) => {
    console.error(err.message);
    db.end().finally(() => process.exit(1));
  });
