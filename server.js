# Aptly Board API — "Renter Leads"

You have access to the Aptly Board API for the board named "Renter Leads" (ID: 4EMDSYKirhQaNdQKz).

## Authentication
All requests require an API key passed as the x-token HTTP header:
  x-token: <your-api-key>
Use the following API key for all requests: oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=

## Base URL
https://core-api.getaptly.com

## Endpoints

### List cards (paginated)
GET https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz?page=0&pageSize=20
Optional query params: updatedAtMin (ISO date), includeArchived (true/false)

### Get a single card
GET https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz/<cardId>

### Create or update a card
POST https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz
Content-Type: application/json
Body: JSON object with field keys and values (see schema below)

### Add a comment to a card
POST https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz/<cardId>/comment
Content-Type: application/json
Body: { "userId": "<aptly-user-id>", "content": "comment text" }

### Upload a file to a card
POST https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz/<cardId>/file
Content-Type: multipart/form-data
Field: file (the file to upload, max 50 MB)

### Add a tab view to the board
POST https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz/tabView
Content-Type: application/json
Body: { "name": "Tab Name", "url": "https://...", "icon": "fa-regular fa-globe", "userIds": [], "createdBy": "<aptly-user-id>" }
Optional fields: icon, embedSource, filter, userIds, createdBy

### Get the field schema for this board
GET https://core-api.getaptly.com/api/schema/4EMDSYKirhQaNdQKz
Returns an array of: { key, label, type }
Always fetch the schema first so you know which field keys to use.

## Important
- All card data is keyed by field key (UUID), not field name. Use the schema endpoint to map keys to human-readable labels.
- Responses include a "cardId" property which is the card's unique ID.
- Money fields are returned as { amount, currency } where amount is a decimal.
- The API returns field values as-is; dates are ISO strings.
