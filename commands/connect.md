---
description: Connect a Portfolio Manager property to Soapbox
argument-hint: [Portfolio Manager username and property name to search for]
---
Connect a Portfolio Manager property to Soapbox (one-time setup):
1. Call connect_property with the user's PM credentials and property name
2. If multiple properties found, call share_property with the correct ID
3. Confirm with list_shared_properties
Note: user credentials are used transiently and never stored.
$ARGUMENTS
