'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../public/logic');

const dataDir = path.join(__dirname, '..', 'data');
const EXP_TXT = fs.readFileSync(path.join(dataDir, 'expense_list.txt'), 'utf8');
const VEN_TXT = fs.readFileSync(path.join(dataDir, 'vendor_list.txt'), 'utf8');
const EXP = L.parseExp(EXP_TXT);
const VEN = L.parseVen(VEN_TXT);
const logic = L.make(EXP, VEN);

const PURPOSES = [
  ['project', 'Project work (direct cost)', 'Field or travel costs for a billable project. Use the "(Direct)" expense types and the project number.'],
  ['training', 'Training or conference', 'Use the 35xx "TRE" types (lodging, lodging tax, meals, airfare incl. baggage, rental car, mileage, other transportation, registration fees).'],
  ['bd', 'Business development', 'Use the 33xx "BSD" types. These need management approval before the cost is incurred.'],
  ['mgmt', 'Management', 'Use the 32xx "M" types. These need management approval before the cost is incurred.'],
  ['office', 'Office / internal travel', 'Use the 3010-3014 "Office" types (internal management travel).'],
  ['general', 'General overhead (not travel)', 'Non-project purchases: 3062 Supplies, 3022 Supplies - Computer, 3021 Telephone, 3131 Employee Professional Registration, 3026 Computer Software and Support, 3020 shipping, 3060 printing, 3015 Vehicle Fleet, etc.'],
];
const purpose = (id) => PURPOSES.find((p) => p[0] === id) || PURPOSES[0];

const RULES = `Strinteg expense rules:
- Alcohol goes on its own line (kind "alcohol") with category "7000 Accounting Department to Update". Never fold alcohol into a meal.
- Lodging: room charges go to the lodging type; taxes, occupancy and tourism fees go to the matching lodging-tax type. Room-service or restaurant charges on a hotel folio go to meals. Parking on a folio goes to parking / other transportation.
- Tips go to the same category as the meal they belong to.
- Sales tax, shipping or environmental fees on a store receipt whose items fall in MORE THAN ONE category get category "${L.SPREAD}" (they are split across the items by amount). If every item is in one category, give tax and fees that category.
- Baggage fees: "Baggage Fees (Direct)" for project travel; for training travel they go with "3510 TRE - Airfare".
- Fuel for a rental car goes to "Rental Car Gas (Direct)" on project travel; fuel for a company or personal vehicle is "Gas (Direct)".
- Phone bills: "3021 Telephone"; only $100 per month is claimable.
- Computer items (drives, cables, adapters, toner, mice) go to "3022 Supplies - Computer" unless bought for a specific project, in which case "Field Supplies (Direct)".
- Vehicle outfitting over $2,500 goes to "7000 Accounting Department to Update".
- If no category fits, use "7000 Accounting Department to Update" with low confidence and say why.
- Payments, change due, card authorizations, loyalty points and "you saved" lines are NOT line items.`;

module.exports = { ...logic, EXP, VEN, EXP_TXT, VEN_TXT, SPREAD: L.SPREAD, PURPOSES, purpose, RULES, r2: L.r2, money: L.money };
