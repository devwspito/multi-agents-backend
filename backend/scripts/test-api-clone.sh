#!/bin/bash

# Test cloning via the deployed API

echo "================================================================================"
echo "🚀 TESTING REPOSITORY CLONE VIA DEPLOYED API"
echo "================================================================================"

# First, let's login to get a token
echo -e "\n📝 Logging in as devwspito..."

LOGIN_RESPONSE=$(curl -s -X POST https://multi-agents-backend.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "dev@wspito.com",
    "password": "Dev123456@"
  }')

TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"token":"[^"]*' | sed 's/"token":"//')

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to login. Response:"
  echo $LOGIN_RESPONSE
  exit 1
fi

echo "✅ Login successful!"
echo "   Token: ${TOKEN:0:20}..."

# Now test the clone endpoint
echo -e "\n🔄 Testing repository clone..."

CLONE_RESPONSE=$(curl -s -X POST https://multi-agents-backend.onrender.com/api/repository-test/clone \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "68e380509201311999de3c45",
    "repositoryName": "opocheckchat"
  }')

# Check if successful
if echo "$CLONE_RESPONSE" | grep -q '"success":true'; then
  echo -e "\n✅ SUCCESS! Repository cloned successfully!"
  echo -e "\n📊 Response:"
  echo "$CLONE_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$CLONE_RESPONSE"
else
  echo -e "\n❌ Clone failed. Response:"
  echo "$CLONE_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$CLONE_RESPONSE"
fi

echo -e "\n================================================================================"
echo "TEST COMPLETED"
echo "================================================================================"