echo "pm2 required (npm install -g pm2)"
echo "pm2 init..."

cd .
pm2 start npm --name wadgateway -- start


echo "Usage: pm2 start/stop wadbudget | pm2 list"
