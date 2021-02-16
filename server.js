const express = require('express');
const cors = require('cors');
const axios = require('axios');
const axiosRetry = require ('axios-retry');
const _ = require('lodash');

axiosRetry(axios, { retries: 5});

const app = express();
app.use(cors());    // Enable all CORS Requests

let FAILED_REQUESTS_LOG = 0;
let SUCCESSFUL_REQUESTS_LOG = 0;

const port = process.env.PORT || 8080;

// Need access token to make requests
if(!process.env.ACCESS_TOKEN || process.env.ACCESS_TOKEN === 'null') {
    console.log("Generating token.")
    generateToken().then(response => {
        process.env.ACCESS_TOKEN = response.data.access_token;
        console.log(`Generated token: ${process.env.ACCESS_TOKEN}`);
        let today = getDate();
        today = addDays(today, 30);
        process.env.EXPIRE_DATE = today;
        console.log(`New token expires on ${process.env.EXPIRE_DATE}`);
    }).catch(err => {
        console.log("Error generating token:");
        console.log(err);
    });
}

app.listen(port, () => {
    console.log(`App listening on http://localhost:${port}`);
});

app.get('/', (req, res) => {
    res.send('Yo');
});

app.get('/:channel/', (req, res) => {
    let channel = req.params.channel;
    let minimum = parseInt(req.query.minimum) || 1000; // If limit is not specified

    if(!checkValidToken) {
        console.log("Generating token.")
        generateToken().then(response => {
            process.env.ACCESS_TOKEN = response.data.access_token;
            console.log(`Generated token: ${process.env.ACCESS_TOKEN}`);
            let today = getDate();
            today = addDays(today, 30);
            process.env.EXPIRE_DATE = today;
            console.log(`New token expires on ${process.env.EXPIRE_DATE}`);
        }).catch(err => {
            console.log("Error generating token:");
            console.log(err);
        });
    }

    if(!channel) {
        res.send("Must specify channel.");
    } else {
        console.log(`Looking for ${channel}'s chatters with at least ${minimum} followers...`);
        getCloutedViewers(channel, minimum).then(results => {
            console.log(`Viewers: ${results.length}`);
            let cloutedViewers = [];
            let fulfilled = 0;
            let rejected = 0;
            results.forEach(result => {
                if(result.status === 'fulfilled') {
                    fulfilled++;
                    if(result.value) {
                        cloutedViewers.push(result.value);
                    }
                } else if(result.status === 'rejected') {
                    rejected++;
                }
            })
            let totalRequests = SUCCESSFUL_REQUESTS_LOG + FAILED_REQUESTS_LOG;
            let percentSuccess = (SUCCESSFUL_REQUESTS_LOG/totalRequests)*100;
            let percentFailed = (FAILED_REQUESTS_LOG/totalRequests)*100;

            console.log(`Clouted Viewers: ${cloutedViewers.length}`);
            console.log(`Rejected: ${rejected}`);
            console.log(`Fulfilled: ${fulfilled}`);
            console.log(`Successful Axios Requests: ${SUCCESSFUL_REQUESTS_LOG} (${percentSuccess.toFixed(2)}%)`);
            console.log(`Failed Axios Requests: ${FAILED_REQUESTS_LOG} (${percentFailed.toFixed(2)}%)`);
            SUCCESSFUL_REQUESTS_LOG = 0;
            FAILED_REQUESTS_LOG = 0;
            res.send(cloutedViewers);
        }).catch(err => {
            console.log(err);
            res.send('No chatters.');
        })
    }
});


/******************************************************************/

function getCloutedViewers(channel, minimum) {
    // Get an array of chatters
    let chatterPromise = getChatters(channel);

    // Get an array of user IDs from chatters
    // This promise gets resolved when all promises are resolved
    let chatterIdsPromises = chatterPromise.then(res => {
        const API = 'https://api.twitch.tv/helix/users?';

        // obj: { chatter_count, vips, moderators, staff, admins, viewers }
        const { chatter_count, vips, moderators, staff, admins, viewers } = res;

        let usernames = [...vips, ...moderators, ...staff, ...admins, ...viewers];
        let ids = [];

        while(usernames.length > 0) {
            let params = '';
            let count = 0;

            while(count < 100 && usernames.length > 0) {
                params += `login=${usernames.pop()}&`;
                count++;
            }

            ids.push(axios({
                method: 'get',
                url: `${API}${params}`,
                headers: {
                    Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
                    "Client-Id": process.env.CLIENT_ID
                }
            }));
        }
        return Promise.all(ids);
    }).catch(err => {
        console.log("Error: chatterIdsPromises");
        console.log(err);
    });

    // For each user ID, make a request for the amount of followers it has, put into array
    // and resolve when all those requests are done
    let chatterInfoRequestPromises = chatterIdsPromises.then(results => {
        let ids = [];
        // First, aggregate into one array
        for(let i = 0; i < results.length; i++) {
            let userData = results[i].data.data;
            if(userData) {
                for(let j = 0; j < userData.length; j++) {
                    ids.push(userData[j].id);
                }
            }
        }

        let requests = [];
        for(let i = 0; i < ids.length; i++) {
            let API = `https://api.twitch.tv/kraken/channels/${ids[i]}`;
            requests.push(axios({ 
                method: 'get',
                url: API,
                timeout: 5000,
                headers: {
                    Accept: 'application/vnd.twitchtv.v5+json',
                    "Client-ID": process.env.CLIENT_ID
                },
            }).then(res => {
                SUCCESSFUL_REQUESTS_LOG++;
                if(res.data.followers >= minimum) {
                    const properties = ['display_name', '_id', 'name', 'partner', 'logo', 'profile_banner', 'url', 'followers', 'views', 'description'];
                    return _.pick(res.data, properties);
                }
            }).catch(err => {
                FAILED_REQUESTS_LOG++;
            }));
        }
        return Promise.allSettled(requests);
    }).catch(err => {
        console.log("Error: chatterInfoRequestPromises");
        console.log(err);
    });

    return chatterInfoRequestPromises;
}

function getChatters(channel) {
    console.log(`Searching: ${channel}`);
    console.log('Getting chatters')

    const API = `https://tmi.twitch.tv/group/user/${channel.toLowerCase()}/chatters`;
    
    return new Promise((resolve, reject) => {
        axios({
            method: 'get',
            url: API,
        }).then((response) => {
            const { chatter_count } = response.data;
            const { vips, moderators, staff, admins, viewers } = response.data.chatters;
            resolve({
                chatter_count, vips, moderators, staff, admins, viewers
            });
        }).catch(err => console.log(err))
    });
}

function generateToken() {
    const endpoint = `https://id.twitch.tv/oauth2/token?client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}&grant_type=client_credentials`;
    return axios({
        method: 'post',
        url: endpoint
    });
}

function getDate() {
    return new Date(Date.now());
}

function addDays(date, days) {
    let result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function checkValidToken() {
    if(Date.now() < process.env.EXPIRE_DATE) {
        return true;
    } else {
        return false;
    }
}